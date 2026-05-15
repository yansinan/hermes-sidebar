export type ManifestV3 = {
  manifest_version: 3;
  name: string;
  version: string;
  description?: string;
  permissions?: string[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
  side_panel?: { default_path: string };
  action?: {
    default_title?: string;
    default_icon?: Record<string, string>;
  };
  icons?: Record<string, string>;
  background?: { service_worker: string; type?: "module" | "classic" };
  web_accessible_resources?: Array<{
    resources: string[];
    matches: string[];
    use_dynamic_url?: boolean;
  }>;
  minimum_chrome_version?: string;
};
