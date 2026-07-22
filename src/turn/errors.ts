/** Turn 失败终态对前端公开的稳定错误码；领域内部错误在进入终态时映射到这里。 */
export type TurnFailureCode =
  | 'auth/api_key_invalid'
  | 'provider/context_too_long'
  | 'provider/model_capability_unsupported'
  | 'provider/server_error'
  | 'provider/tool_arguments_invalid_json'
  | 'provider/not_configured'
  | 'turn/budget_exceeded'
  | 'turn/hook_aborted'
  | 'turn/attachment_failed'
  | 'turn/setup_failed'
  | 'turn/execution_failed';
