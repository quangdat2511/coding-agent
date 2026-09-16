export interface ApiKeySource {
  name: string;
  resolve(): Promise<string | undefined>;
}

export interface ProviderCredentials {
  apiKey?: ApiKeySource;
}
