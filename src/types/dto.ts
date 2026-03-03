export type ConditionType =
  | "always"
  | "utm"
  | "device"
  | "language"
  | "newReturning"
  | "url"
  | "referrer"
  | "geo"
  | "time";

export type Comparator = "equals" | "contains" | "startsWith" | "endsWith" | "greaterThan" | "lessThan" | "between";

export interface Condition {
  id: string;
  type: ConditionType;
  key?: string;
  comparator?: Comparator;
  value?: string;
}

export type Field =
  | "text"
  | "visible"
  | "href"
  | "className"
  | "style"
  | "attribute";

export interface VariantMutation {
  field: Field;
  value: string;
  attributeName?: string;
}

export interface VariantDTO {
  id: string;
  name: string;
  mutations: VariantMutation[];
}

export interface Split {
  variantId: string;
  weight: number;
}

export interface RuleDTO {
  id: string;
  description?: string;
  conditions: Condition[];
  logic: "AND" | "OR";
  variantId: string;
  priority: number;
  enabled: boolean;
  startDate?: string;
  endDate?: string;
  splits?: Split[];
  audienceId?: string;
}

export interface ElementConfigDTO {
  id: string;
  label: string;
  selector: string;
  variants: VariantDTO[];
  rules: RuleDTO[];
}

export interface ProjectConfigDTO {
  id: string;
  siteUrl: string;
  elements: ElementConfigDTO[];
  recordingEnabled?: boolean;
}

export interface AudienceDTO {
  id: string;
  name: string;
  conditions: Condition[];
  logic: "AND" | "OR";
}

export interface UserDTO {
  id: string;
  email: string;
  name?: string;
  createdAt: string;
}

export interface ProjectDTO {
  id: string;
  name: string;
  siteUrl: string;
  publicKey: string;
  recordingEnabled: boolean;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuthResponse {
  user: UserDTO;
  token: string;
}
