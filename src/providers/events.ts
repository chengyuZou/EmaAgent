// Provider 配置、模型池、业务绑定和探活写入后的跨窗口变更通知。
export type ProviderEvent =
  | { readonly type: 'provider_config_changed' }
  | { readonly type: 'provider_models_changed'; readonly providerId: string }
  | { readonly type: 'model_bindings_changed' }
  | { readonly type: 'provider_health_changed'; readonly providerId: string };
