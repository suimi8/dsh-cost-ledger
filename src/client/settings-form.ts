/**
 * Settings-form engine for the cost-ledger settings card.
 *
 * A trimmed port of the dsh-task-board CardForm: stages user edits in memory
 * and writes them through the bound SettingsScope on save. The host is the
 * authority on whether a write lands, so save reads back to confirm.
 *
 * Fields are flat. The `pricing` object (Record<model, ModelPrice>) is edited
 * as a single JSON text field (FieldSpec with set/clear of the whole object),
 * which keeps the engine simple and supports dynamic model keys.
 */

// Minimal type-only mirrors of @deepseek-ai/dsh-client-runtime/client shapes.
export interface SettingsScopeSnapshot<T> {
  status: 'ready' | 'loading' | 'unavailable'
  writable: boolean
  value: T | undefined
  base: Partial<T> | undefined
  user: Record<string, unknown> | undefined
}
export interface SettingsScope<T> {
  getSnapshot(): SettingsScopeSnapshot<T>
  subscribe(cb: () => void): () => void
  set(field: string, value: unknown): Promise<void>
  unset(field: string): Promise<void>
}
export interface SnapshotStore<S> {
  getSnapshot(): S
  subscribe(cb: () => void): () => void
}
export interface MutableSnapshotStore<S> extends SnapshotStore<S> {
  set(v: S): void
}
export function createSnapshotStore<S>(initial: S): MutableSnapshotStore<S> {
  let cur = initial
  const cbs = new Set<() => void>()
  return {
    getSnapshot: () => cur,
    subscribe: (cb: () => void) => { cbs.add(cb); return () => { cbs.delete(cb) } },
    set: (v: S) => { cur = v; for (const cb of cbs) cb() },
  }
}

// --- Field specs ---------------------------------------------------------

export type FieldWrite = { kind: 'set'; value: unknown } | { kind: 'clear' }

export interface FieldSpec {
  field: string
  format: (value: unknown) => string
  parse: (text: string) => FieldWrite | undefined
}

export interface FieldState {
  text: string
  overridden: boolean
  invalid: boolean
}

export interface CardShell {
  available: boolean
  writable: boolean
  dirty: boolean
  invalid: boolean
  saving: boolean
  failed: boolean
}

export interface CardActions {
  edit: (field: string, text: string) => void
  resetField: (field: string) => void
  save: () => void
  discard: () => void
}

export function numberField(field: string): FieldSpec {
  return {
    field,
    format: (v) => (typeof v === 'number' ? String(v) : ''),
    parse: (text) => {
      const t = text.trim()
      if (t === '') return { kind: 'clear' }
      const n = Number(t)
      return Number.isFinite(n) ? { kind: 'set', value: n } : undefined
    },
  }
}

/** A whole-object JSON field (for the dynamic-key pricing dict). */
export function jsonField(field: string): FieldSpec {
  return {
    field,
    format: (v) => (v && typeof v === 'object' ? JSON.stringify(v, null, 2) : ''),
    parse: (text) => {
      const t = text.trim()
      if (t === '') return { kind: 'clear' }
      try {
        const parsed = JSON.parse(t)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return { kind: 'set', value: parsed }
        }
        return undefined
      } catch {
        return undefined
      }
    },
  }
}

// --- CardForm ------------------------------------------------------------

interface StagedEdit { text: string; clear: boolean }
interface PlannedWrite { field: string; run: (() => Promise<boolean>) | undefined }

export class CardForm<T> {
  private readonly specs: Map<string, FieldSpec>
  private readonly staged = new Map<string, StagedEdit>()
  private readonly listeners = new Set<() => void>()
  private saving = false
  private failed = false

  constructor(
    private readonly scope: SettingsScope<T>,
    specs: FieldSpec[],
  ) {
    this.specs = new Map(specs.map((s) => [s.field, s]))
    scope.subscribe(() => this.publish())
  }

  bind<S>(project: () => S): MutableSnapshotStore<S> {
    const store = createSnapshotStore(project())
    this.listeners.add(() => store.set(project()))
    return store
  }

  shell(): CardShell {
    const snap = this.scope.getSnapshot()
    const plan = this.plan()
    return {
      available: snap.status === 'ready',
      writable: snap.writable,
      dirty: plan.length > 0,
      invalid: plan.some((p) => p.run === undefined),
      saving: this.saving,
      failed: this.failed,
    }
  }

  field(name: string): FieldState {
    const spec = this.specOf(name)
    const staged = this.staged.get(name)
    if (staged === undefined) {
      return { text: spec.format(this.sectionValue(name)), overridden: this.stored(name), invalid: false }
    }
    const write = staged.clear ? { kind: 'clear' as const } : spec.parse(staged.text)
    return { text: staged.text, overridden: write?.kind === 'set', invalid: write === undefined }
  }

  actions(): CardActions {
    return {
      edit: (f, text) => this.stage(f, { text, clear: false }),
      resetField: (f) => this.stage(f, { text: this.specOf(f).format(this.baseValue(f)), clear: true }),
      save: () => { void this.save() },
      discard: () => {
        if (this.staged.size === 0 && !this.failed) return
        this.staged.clear()
        this.failed = false
        this.publish()
      },
    }
  }

  async save(): Promise<void> {
    const plan = this.plan()
    const writes = plan.filter((p) => p.run !== undefined).map((p) => p.run!)
    if (plan.length === 0 || this.saving || writes.length !== plan.length) return
    this.saving = true
    this.failed = false
    this.publish()
    let landed = true
    for (const w of writes) landed = (await w()) && landed
    if (landed) this.staged.clear()
    this.saving = false
    this.failed = !landed
    this.publish()
  }

  private plan(): PlannedWrite[] {
    const out: PlannedWrite[] = []
    for (const [field, staged] of this.staged) {
      const spec = this.specOf(field)
      if (staged.clear) {
        if (this.stored(field)) out.push({ field, run: () => this.clear(field) })
        continue
      }
      if (staged.text === spec.format(this.sectionValue(field))) continue
      const write = spec.parse(staged.text)
      if (write === undefined) out.push({ field, run: undefined })
      else if (write.kind === 'clear') out.push({ field, run: () => this.clear(field) })
      else out.push({ field, run: () => this.store(field, write.value) })
    }
    return out
  }

  private async clear(field: string): Promise<boolean> {
    await this.scope.unset(field)
    return !this.stored(field)
  }
  private async store(field: string, value: unknown): Promise<boolean> {
    await this.scope.set(field, value)
    return (this.scope.getSnapshot().user as Record<string, unknown> | undefined)?.[field] === value
  }
  private stage(field: string, edit: StagedEdit): void {
    this.staged.set(field, edit)
    this.failed = false
    this.publish()
  }
  private specOf(field: string): FieldSpec {
    const spec = this.specs.get(field)
    if (!spec) throw new Error(`settings card has no field ${field}`)
    return spec
  }
  private sectionValue(field: string): unknown {
    return (this.scope.getSnapshot().value as Record<string, unknown> | undefined)?.[field]
  }
  private baseValue(field: string): unknown {
    return (this.scope.getSnapshot().base as Record<string, unknown> | undefined)?.[field]
  }
  private stored(field: string): boolean {
    const u = this.scope.getSnapshot().user
    return u !== undefined && Object.hasOwn(u, field)
  }
  private publish(): void {
    for (const l of this.listeners) l()
  }
}
