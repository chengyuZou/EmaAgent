// 集中声明内置工具稳定身份和模型可见名称，避免权限、恢复与展示继续共用一个字符串。
// 身份定义放在工具框架层(tools)：框架层的规则系统/设置/目录投影都需要引用工具
// 身份；具体工具实现包(builtinTools)从本包导入再导出，保持既有消费路径不变。
// variant 是工具的职责分组（前端展示分组的唯一事实源），逐工具名映射不归消费方维护。
export type BuiltinToolVariant = 'read' | 'search' | 'shell' | 'edit' | 'ask' | 'task' | 'skill' | 'agent';

export interface BuiltinToolIdentity {
  readonly id: string;
  readonly name: string;
  readonly variant: BuiltinToolVariant;
}

export const BuiltinTools = Object.freeze({
  FileRead:  Object.freeze({ id: 'builtin.file.read',  name: 'Read', variant: 'read' }),
  PdfRead:   Object.freeze({ id: 'builtin.pdf.read',   name: 'PdfRead', variant: 'read' }),
  FileEdit:  Object.freeze({ id: 'builtin.file.edit',  name: 'Edit', variant: 'edit' }),
  FileWrite: Object.freeze({ id: 'builtin.file.write', name: 'Write', variant: 'edit' }),
  Glob:      Object.freeze({ id: 'builtin.search.glob', name: 'Glob', variant: 'search' }),
  Grep:      Object.freeze({ id: 'builtin.search.grep', name: 'Grep', variant: 'search' }),
  WebFetch:  Object.freeze({ id: 'builtin.web.fetch',  name: 'WebFetch', variant: 'search' }),
  WebSearch: Object.freeze({ id: 'builtin.web.search', name: 'WebSearch', variant: 'search' }),
  Bash:       Object.freeze({ id: 'builtin.shell.bash',       name: 'Bash', variant: 'shell' }),
  PowerShell: Object.freeze({ id: 'builtin.shell.powershell', name: 'PowerShell', variant: 'shell' }),
  ProcessList: Object.freeze({ id: 'builtin.process.list', name: 'ProcessList', variant: 'shell' }),
  ProcessOutput: Object.freeze({ id: 'builtin.process.output', name: 'ProcessOutput', variant: 'shell' }),
  ProcessStop: Object.freeze({ id: 'builtin.process.stop', name: 'ProcessStop', variant: 'shell' }),
  AskUser:    Object.freeze({ id: 'builtin.user.ask',         name: 'AskUser', variant: 'ask' }),
  TodoWrite:  Object.freeze({ id: 'builtin.todo.write',       name: 'TodoWrite', variant: 'task' }),
  TaskCreate: Object.freeze({ id: 'builtin.task.create', name: 'TaskCreate', variant: 'task' }),
  TaskGet:    Object.freeze({ id: 'builtin.task.get',    name: 'TaskGet', variant: 'task' }),
  TaskList:   Object.freeze({ id: 'builtin.task.list',   name: 'TaskList', variant: 'task' }),
  TaskUpdate: Object.freeze({ id: 'builtin.task.update', name: 'TaskUpdate', variant: 'task' }),
  KnowledgeBaseSearch: Object.freeze({
    id: 'builtin.knowledge_base.search',
    name: 'KnowledgeBaseSearch',
    variant: 'search',
  }),
  NarrativeSearch: Object.freeze({
    id: 'builtin.narrative.search',
    name: 'NarrativeSearch',
    variant: 'search',
  }),
  MemorySearch: Object.freeze({ id: 'builtin.memory.search', name: 'MemorySearch', variant: 'search' }),
  MemoryRead:   Object.freeze({ id: 'builtin.memory.read',   name: 'MemoryRead', variant: 'read' }),
  MemoryList:   Object.freeze({ id: 'builtin.memory.list',   name: 'MemoryList', variant: 'search' }),
  MemoryNote:   Object.freeze({ id: 'builtin.memory.note',   name: 'MemoryNote', variant: 'edit' }),
  Skill: Object.freeze({ id: 'builtin.skill', name: 'Skill', variant: 'skill' }),
  ScratchpadWrite:  Object.freeze({ id: 'builtin.scratchpad.write',  name: 'ScratchpadWrite', variant: 'edit' }),
  ScratchpadRead:   Object.freeze({ id: 'builtin.scratchpad.read',   name: 'ScratchpadRead', variant: 'read' }),
  ScratchpadList:   Object.freeze({ id: 'builtin.scratchpad.list',   name: 'ScratchpadList', variant: 'search' }),
  ScratchpadDelete: Object.freeze({ id: 'builtin.scratchpad.delete', name: 'ScratchpadDelete', variant: 'edit' }),
  ScratchpadClear:  Object.freeze({ id: 'builtin.scratchpad.clear',  name: 'ScratchpadClear', variant: 'edit' }),
  Subagent: Object.freeze({ id: 'builtin.subagent.run', name: 'Subagent', variant: 'agent' }),
  SubagentAwait: Object.freeze({ id: 'builtin.subagent.await', name: 'SubagentAwait', variant: 'agent' }),
} satisfies Record<string, BuiltinToolIdentity>);
