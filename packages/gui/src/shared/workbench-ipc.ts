import type { PermissionMode, PermissionModeState } from "@herta/core";
export type NavigationPermissionMode =
  | "read-only"
  | "workspace-edit"
  | "full-access";
export interface NavigationSession {
  sessionId: string;
  workspace: string;
  title?: string;
  isDefault?: boolean;
}
export interface NavigationProject {
  projectId: string;
  path: string | null;
  name: string;
  alias: string | null;
  pinned: boolean;
  pinOrder: number;
  expanded: boolean;
  removed: boolean;
  permissionMode: NavigationPermissionMode;
}
export interface NavigationTask {
  sessionId: string;
  projectId: string;
  pinned: boolean;
  pinOrder: number;
  recycled: boolean;
  permissionMode: NavigationPermissionMode | null;
}
export interface ProjectNavigationView {
  schemaVersion: 1;
  revision: number;
  projects: NavigationProject[];
  tasks: NavigationTask[];
}

export type NavigationMutation =
  | { readonly kind: "create-project"; readonly path: string | null }
  | {
      readonly kind: "relocate-project";
      readonly projectId: string;
      readonly path: string;
    }
  | {
      readonly kind: "rename-project";
      readonly projectId: string;
      readonly name: string | null;
    }
  | {
      readonly kind: "pin-project";
      readonly projectId: string;
      readonly pinned: boolean;
    }
  | {
      readonly kind: "expand-project";
      readonly projectId: string;
      readonly expanded: boolean;
    }
  | {
      readonly kind: "remove-project";
      readonly projectId: string;
      readonly recycleTasks: boolean;
    }
  | {
      readonly kind: "pin-task";
      readonly sessionId: string;
      readonly pinned: boolean;
    }
  | {
      readonly kind: "recycle-task";
      readonly sessionId: string;
    };

export interface WorkbenchPermission extends PermissionModeState {
  readonly sessionId: string | null;
  readonly projectId: string | null;
  readonly source: "project" | "session" | "default";
  readonly projectMode: PermissionMode;
}
export interface SetWorkbenchPermissionInput {
  readonly sessionId: string;
  readonly mode: PermissionMode | null;
  readonly scope: "session" | "project";
  readonly expectedRevision: number;
  /** Explicit one-time user acknowledgement; never authored by model tools. */
  readonly confirmFullAccess?: boolean;
}

export type { PendingUserInput, UserInputAnswer } from "@herta/app-server";
