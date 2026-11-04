export interface ApiKeySource {
  readonly name: string;
  readonly envVars?: readonly string[];
  resolve(): Promise<string | undefined>;
}

export interface ProviderCredentials {
  apiKey?: ApiKeySource;
}
