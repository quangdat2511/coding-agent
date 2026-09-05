export interface ApiKeyAuth {
  name: string;
  resolve(): Promise<string | undefined>;
}

export interface ProviderAuth {
  apiKey?: ApiKeyAuth;
}
