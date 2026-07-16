// 这里集中声明内置工具稳定身份和模型可见名称，避免权限、恢复与展示继续共用一个字符串。
export interface BuiltinToolIdentity {
  readonly id: string;
  readonly name: string;
}

export const BuiltinTools = Object.freeze({
  FileRead:  Object.freeze({ id: 'builtin.file.read',  name: 'Read' }),
  FileEdit:  Object.freeze({ id: 'builtin.file.edit',  name: 'Edit' }),
  FileWrite: Object.freeze({ id: 'builtin.file.write', name: 'Write' }),
  Glob:      Object.freeze({ id: 'builtin.search.glob', name: 'Glob' }),
  Grep:      Object.freeze({ id: 'builtin.search.grep', name: 'Grep' }),
  WebFetch:  Object.freeze({ id: 'builtin.web.fetch',  name: 'WebFetch' }),
  WebSearch: Object.freeze({ id: 'builtin.web.search', name: 'WebSearch' }),
} satisfies Record<string, BuiltinToolIdentity>);
