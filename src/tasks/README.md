# Tasks

`TaskStore` 是持久 Task 的业务入口：创建、按 Session 查询，以及带版本条件的更新、取消和删除。提醒周期的 `markReminded` 只改变提醒基准，不改变任务列表投影。

创建或真正改变 Task 行后发 `tasks_changed { sessionId }`。Chat 只对已加载的会话任务列表重新查询；连续通知在窗口内合并。Turn 终态仍会刷新任务面板，以覆盖执行收口后的视图。
