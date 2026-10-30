# Why history branches within a Session were deferred

[中文](README-zh.md) | [Documentation](../../README.md)

We tried retaining old nodes within one Session and adding new nodes to support history editing and branch switching. We dropped that design because execution ownership became too complex, not because finding the lowest common ancestor(LCA) was too slow.

## Why retaining old nodes is not enough

History includes more than saved messages. A branch can start a subagent that is still running. Background work may finish and produce a result after the user switches branches.

Starting a subagent in branch one and then switching to branch two requires deciding whether that result may enter the current conversation. Even if delivery to branch two is prohibited, the system must still determine the owning Turn, where it branched, and how it relates to the current history.

The otherwise clear Session, Turn, and Message ID relationships therefore need branch relationships, inheritance boundaries, and delivery rules for derived work. Adding nodes while retaining old ones does not automatically settle these questions.

## Why LCA cannot make the decision for us

The lowest common ancestor, LCA, helps locate the shared history position of two nodes. It describes their relationship; it cannot decide whether an old branch's subagent result belongs in another branch.

We do not want to keep adding those business decisions solely to preserve history branching. Even a fast tree query leaves the need to explain the ownership and visibility of derived work and handle execution that is still active during a branch switch.

## What we retain for now

We deferred history branch editing and switching within a Session, retaining explicit Session, Turn, and Message relationships. Current fork copies history into another Session, where subsequent execution is saved separately, rather than switching active branches within the original Session.

The cost is that users cannot freely choose an old branch and continue within the same Session, or use that earlier design to edit a Turn while retaining every subsequent branch. We accept this feature scope and will reconsider it when users identify a concrete need.

Before revisiting tree structures or shared-ancestor lookup, the ownership of background results, derived tasks, and visible history must be settled. Current fork's resource and history contracts are in the [Session module](../../../src/session/README.md).
