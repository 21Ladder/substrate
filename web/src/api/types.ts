export type ID = string;
export type PageKind = "page" | "database";

export interface PageMeta {
  id: ID;
  parentId: ID | null;
  /** Gesetzt, wenn die Seite ein Eintrag einer Datenbank ist. */
  databaseId: ID | null;
  kind: PageKind;
  title: string;
  icon: string | null;
  sortKey: string;
  favorite: boolean;
  /** Datenbank, die als Block in einer Seite steht (statt als ganze Seite). */
  inline: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface PageSettings {
  fullWidth?: boolean;
  smallText?: boolean;
  font?: "default" | "serif" | "mono";
  locked?: boolean;
  coverPos?: number;
}

export interface DocJSON {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocJSON[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

export interface PageFull extends PageMeta {
  cover: string | null;
  props: Record<string, unknown>;
  content: DocJSON | null;
  settings: PageSettings;
  deletedAt: number | null;
}

export interface LinkItem {
  dst: ID;
  kind: "mention" | "relation";
  prop?: string;
}

export interface LinksPatch {
  kinds: LinkItem["kind"][];
  items: LinkItem[];
}

export interface PagePatch {
  title?: string;
  icon?: string | null;
  cover?: string | null;
  props?: Record<string, unknown>;
  /** Merge-Patch für Eigenschaften (null entfernt), wird in SQLite zusammengeführt. */
  propsPatch?: Record<string, unknown>;
  content?: DocJSON;
  settings?: PageSettings;
  sortKey?: string;
  parentId?: ID | null;
  databaseId?: ID | null;
  favorite?: boolean;
  inline?: boolean;
  /** Klartext für die Volltextsuche. */
  text?: string;
  links?: LinksPatch;
  /** Aktuellen Inhalt vor dem Überschreiben in jedem Fall als Version sichern. */
  snapshot?: boolean;
}

export interface CreatePageInput {
  id: ID;
  parentId: ID | null;
  databaseId?: ID | null;
  kind?: PageKind;
  title?: string;
  icon?: string | null;
  cover?: string | null;
  sortKey: string;
  inline?: boolean;
  props?: Record<string, unknown>;
  content?: DocJSON | null;
  settings?: PageSettings;
  text?: string;
  links?: LinksPatch;
  schema?: PropertyDef[];
  views?: ViewDef[];
}

export interface SearchResult {
  id: ID;
  title: string;
  icon: string | null;
  kind: PageKind;
  parentId: ID | null;
  databaseId: ID | null;
  updatedAt: number;
  snippet: string;
}

export interface TrashItem {
  id: ID;
  title: string;
  icon: string | null;
  kind: PageKind;
  parentId: ID | null;
  deletedAt: number;
}

export interface Edge {
  src: ID;
  dst: ID;
  kind: string;
  prop: string;
}

export interface HistoryItem {
  id: number;
  createdAt: number;
  title: string;
}

export interface ImportFile {
  path: string;
  text?: string;
  url?: string;
}

// ---------- Datenbanken ----------

export type PropType =
  | "title"
  | "text"
  | "number"
  | "select"
  | "multi_select"
  | "status"
  | "date"
  | "checkbox"
  | "url"
  | "email"
  | "phone"
  | "files"
  | "relation"
  | "rollup"
  | "formula"
  | "created_time"
  | "last_edited_time"
  | "unique_id";

export type NumberFormat = "number" | "comma" | "percent" | "euro" | "dollar" | "bar" | "ring";

export interface SelectOption {
  id: string;
  name: string;
  color: string;
  /** Nur für Status: Gruppe. */
  group?: "todo" | "progress" | "done";
}

export type RollupFn =
  | "show"
  | "count"
  | "count_values"
  | "unique"
  | "empty"
  | "not_empty"
  | "sum"
  | "average"
  | "median"
  | "min"
  | "max"
  | "range"
  | "checked"
  | "percent_checked"
  | "earliest"
  | "latest";

export interface PropertyDef {
  id: string;
  name: string;
  type: PropType;
  options?: SelectOption[];
  format?: NumberFormat;
  /** Relation: Ziel-Datenbank und optional Gegen-Eigenschaft (zweiseitig). */
  relation?: { databaseId: ID; reverseProp?: string };
  rollup?: { relationProp: string; targetProp: string; fn: RollupFn };
  formula?: string;
  prefix?: string;
  /** Nächste zu vergebende Nummer (unique_id); wird nie wiederverwendet. */
  nextId?: number;
  dateFormat?: "relative" | "full" | "short" | "iso";
}

export type FilterCond =
  | "is"
  | "is_not"
  | "contains"
  | "not_contains"
  | "starts"
  | "ends"
  | "empty"
  | "not_empty"
  | "eq"
  | "neq"
  | "gt"
  | "lt"
  | "gte"
  | "lte"
  | "before"
  | "after"
  | "on_or_before"
  | "on_or_after"
  | "checked"
  | "unchecked";

export interface FilterRule {
  prop: string;
  cond: FilterCond;
  value?: unknown;
}

export interface FilterGroup {
  op: "and" | "or";
  rules: (FilterRule | FilterGroup)[];
}

export interface SortRule {
  prop: string;
  dir: "asc" | "desc";
}

export type ViewType = "table" | "board" | "list" | "gallery" | "calendar" | "graph";

export type CalcFn =
  | "none"
  | "count"
  | "count_values"
  | "unique"
  | "empty"
  | "not_empty"
  | "percent_empty"
  | "percent_not_empty"
  | "sum"
  | "average"
  | "median"
  | "min"
  | "max"
  | "range"
  | "checked"
  | "unchecked"
  | "percent_checked"
  | "earliest"
  | "latest";

export interface ViewDef {
  id: string;
  name: string;
  type: ViewType;
  filter: FilterGroup;
  sorts: SortRule[];
  groupBy?: string | null;
  hidden: string[];
  order: string[];
  widths: Record<string, number>;
  calcs: Record<string, CalcFn>;
  wrap?: boolean;
  cardSize?: "small" | "medium" | "large";
  cardCover?: "none" | "cover" | string;
  dateProp?: string | null;
  collapsedGroups?: string[];
  limit?: number;
}

export interface DatabaseRow {
  id: ID;
  title: string;
  icon: string | null;
  cover: string | null;
  props: Record<string, unknown>;
  sortKey: string;
  createdAt: number;
  updatedAt: number;
}

export interface DatabaseData {
  id: ID;
  schema: PropertyDef[];
  views: ViewDef[];
  rows: DatabaseRow[];
}
