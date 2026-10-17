/** 宿主保存配置或状态后发布, 让各窗口重新读取对应数据. */
export type ProviderEvent =
  | { readonly type: 'provider_config_changed' }
  | { readonly type: 'provider_models_changed'; readonly providerId: string }
  | { readonly type: 'model_bindings_changed' }
  | { readonly type: 'provider_health_changed'; readonly providerId: string };
