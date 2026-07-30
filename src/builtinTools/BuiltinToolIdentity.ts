// 集中声明内置工具稳定身份和模型可见名称，避免权限、恢复与展示继续共用一个字符串。
export interface BuiltinToolIdentity {
  readonly id: string;
  readonly name: string;
}

export const BuiltinTools = Object.freeze({
  FileRead:  Object.freeze({ id: 'builtin.file.read',  name: 'Read' }),
  PdfRead:   Object.freeze({ id: 'builtin.pdf.read',   name: 'PdfRead' }),
  FileEdit:  Object.freeze({ id: 'builtin.file.edit',  name: 'Edit' }),
  FileWrite: Object.freeze({ id: 'builtin.file.write', name: 'Write' }),
  Glob:      Object.freeze({ id: 'builtin.search.glob', name: 'Glob' }),
  Grep:      Object.freeze({ id: 'builtin.search.grep', name: 'Grep' }),
  WebFetch:  Object.freeze({ id: 'builtin.web.fetch',  name: 'WebFetch' }),
  WebSearch: Object.freeze({ id: 'builtin.web.search', name: 'WebSearch' }),
  Bash:       Object.freeze({ id: 'builtin.shell.bash',       name: 'Bash' }),
  ProcessList: Object.freeze({ id: 'builtin.process.list', name: 'ProcessList' }),
  ProcessOutput: Object.freeze({ id: 'builtin.process.output', name: 'ProcessOutput' }),
  ProcessStop: Object.freeze({ id: 'builtin.process.stop', name: 'ProcessStop' }),
  AskUser:    Object.freeze({ id: 'builtin.user.ask',         name: 'AskUser' }),
  AskText:    Object.freeze({ id: 'builtin.user.ask_text',    name: 'AskText' }),
  AskChoice:  Object.freeze({ id: 'builtin.user.ask_choice',  name: 'AskChoice' }),
  AskConfirm: Object.freeze({ id: 'builtin.user.ask_confirm', name: 'AskConfirm' }),
  TaskCreate: Object.freeze({ id: 'builtin.task.create', name: 'TaskCreate' }),
  TaskGet:    Object.freeze({ id: 'builtin.task.get',    name: 'TaskGet' }),
  TaskList:   Object.freeze({ id: 'builtin.task.list',   name: 'TaskList' }),
  TaskUpdate: Object.freeze({ id: 'builtin.task.update', name: 'TaskUpdate' }),
  KnowledgeBaseSearch: Object.freeze({
    id: 'builtin.knowledge_base.search',
    name: 'KnowledgeBaseSearch',
  }),
  NarrativeSearch: Object.freeze({
    id: 'builtin.narrative.search',
    name: 'NarrativeSearch',
  }),
  SkillCall: Object.freeze({ id: 'builtin.skill.call', name: 'SkillCall' }),
  ScratchpadWrite:  Object.freeze({ id: 'builtin.scratchpad.write',  name: 'ScratchpadWrite' }),
  ScratchpadRead:   Object.freeze({ id: 'builtin.scratchpad.read',   name: 'ScratchpadRead' }),
  ScratchpadList:   Object.freeze({ id: 'builtin.scratchpad.list',   name: 'ScratchpadList' }),
  ScratchpadDelete: Object.freeze({ id: 'builtin.scratchpad.delete', name: 'ScratchpadDelete' }),
  ScratchpadClear:  Object.freeze({ id: 'builtin.scratchpad.clear',  name: 'ScratchpadClear' }),
  Subagent: Object.freeze({ id: 'builtin.subagent.run', name: 'Subagent' }),
  SubagentSpawnBackground: Object.freeze({
    id: 'builtin.subagent.spawn_background',
    name: 'SubagentSpawnBackground',
  }),
  SubagentSendMessage: Object.freeze({
    id: 'builtin.subagent.send_message',
    name: 'SubagentSendMessage',
  }),
  SubagentAwait: Object.freeze({ id: 'builtin.subagent.await', name: 'SubagentAwait' }),
  SubagentAbort: Object.freeze({ id: 'builtin.subagent.abort', name: 'SubagentAbort' }),
  PlanEnter: Object.freeze({ id: 'builtin.plan.enter', name: 'PlanEnter' }),
  PlanExit:  Object.freeze({ id: 'builtin.plan.exit',  name: 'PlanExit' }),
} satisfies Record<string, BuiltinToolIdentity>);
