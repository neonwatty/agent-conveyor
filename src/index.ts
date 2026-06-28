export { programNameFromArgv } from "./cli/program-name.js";
export type { CliProgram } from "./cli/program-name.js";
export {
  captureMetaPath,
  configPath,
  defaultDbPath,
  eventsPath,
  loadJsonSync,
  stateRoot,
  statusPath,
  transcriptPath,
  validateWorkerName,
  workerDir,
  WorkerctlStateError,
  writeJsonSync,
} from "./state/files.js";
export { latestStatusSync } from "./state/status.js";
export type { WorkerStatus } from "./state/status.js";
export {
  configureConnectionSync,
  databaseHealthSync,
  initializeDatabaseSync,
  openDatabaseSync,
  WorkerctlDatabaseError,
} from "./state/database.js";
export type { DatabaseCheck, DatabaseHealth } from "./state/database.js";
export { taskAuditSync, TaskAuditError } from "./runtime/audit.js";
export type {
  TaskAuditCorrelationChain,
  TaskAuditEvent,
  TaskAuditManagerDecision,
  TaskAuditNotificationAcknowledgement,
  TaskAuditResult,
  TaskAuditRoutedNotification,
  TaskAuditTask,
} from "./runtime/audit.js";
export {
  appHeartbeatPollCommand,
  appLoopStatusCommand,
  appLoopStatusSync,
  appWakeupDispatchPlanSync,
  appWakeupPlanCommand,
  appWakeupPlanSync,
  directInboxPollCommand,
} from "./runtime/app-autonomy.js";
export type {
  AppLoopDispatchState,
  AppLoopLeaseState,
  AppLoopNextAction,
  AppLoopRole,
  AppLoopRoleStatus,
  AppLoopStatus,
  AppWakeup,
  AppWakeupDispatchAction,
  AppWakeupDispatchActionStatus,
  AppWakeupDispatchPlan,
  AppWakeupPlan,
} from "./runtime/app-autonomy.js";
export {
  addCampaignWorkerSlotSync,
  campaignDashboardSync,
  campaignStatusSync,
  CampaignStateError,
  createCampaignAssignmentSync,
  createCampaignSync,
  recordCampaignAssetReceiptSync,
  updateCampaignWorkerSlotLifecycleSync,
  upsertCampaignChannelBriefSync,
} from "./runtime/campaigns.js";
export type {
  CampaignAssetReceiptRecord,
  CampaignAssetStatus,
  CampaignAssetType,
  CampaignAssignmentRecord,
  CampaignAssignmentStatus,
  CampaignChannelBriefRecord,
  CampaignDashboardRecord,
  CampaignDashboardSlotRecord,
  CampaignNextManagerAction,
  CampaignRecord,
  CampaignSlotLifecycleState,
  CampaignStatus,
  CampaignStatusRecord,
  CampaignWorkerSlotRecord,
  CampaignWorkerSlotState,
} from "./runtime/campaigns.js";
export { exportTaskAuditSubsetSync, exportTaskSync, TaskExportError } from "./runtime/export.js";
export type { TaskExportManifest, TaskExportResult } from "./runtime/export.js";
export { replayEntriesFromAudit, replayResultFromAudit } from "./runtime/replay.js";
export type { ReplayEntry, ReplayMode, ReplayResult, ReplayRole } from "./runtime/replay.js";
export { classifyBusyWait, classifyStartupOutput } from "./runtime/classify.js";
export type { BusyWaitClassification, StartupState } from "./runtime/classify.js";
export {
  claimableDispatchCommandsSync,
  claimNextDispatchCommandSync,
  createCommandSync,
  finishCommandAttemptSync,
  markCommandAttemptSideEffectStartedSync,
  recoverStaleDispatchClaimsSync,
  CommandQueueError,
} from "./runtime/commands.js";
export type { ClaimedCommand, CommandAttemptRecord, CommandRecord, RecoveredDispatchClaim } from "./runtime/commands.js";
export {
  checkDispatchRequiredPermissionSync,
  executeDispatchCommandSync,
  resolveDispatchCommandRouteSync,
  DispatchPermissionError,
  DispatchRoutingError,
} from "./runtime/dispatch.js";
export type { DispatchCommandResult, DispatchCommandRoute, DispatchPermissionCheck } from "./runtime/dispatch.js";
export { managerConfigPermissionAllowed, managerConfigSync } from "./runtime/manager-config.js";
export type { ManagerConfigRecord } from "./runtime/manager-config.js";
export {
  canonicalManagerPermissionNames,
  flattenManagerPermissions,
  managerPermissionAllowed,
  normalizeManagerPermissions,
} from "./runtime/manager-permissions.js";
export type { ManagerPermissions, ManagerPermissionCategory } from "./runtime/manager-permissions.js";
export {
  consumeNextSessionInboxItemSync,
  deferRoutedNotificationBeforeSideEffectSync,
  deliveryModeForTargetSessionSync,
  finishRoutedNotificationSync,
  insertRoutedNotificationSync,
  insertNotificationAcknowledgementSync,
  latestNotificationAcknowledgementSync,
  markRoutedNotificationSideEffectStartedSync,
  notificationAcknowledgementsSync,
  routedNotificationsSync,
  sessionInboxSync,
  RoutedNotificationError,
} from "./runtime/notifications.js";
export type {
  NotificationAcknowledgementRecord,
  NotificationAcknowledgementRole,
  NotificationAcknowledgementStatus,
  RoutedNotificationDeliveryMode,
  RoutedNotificationRecord,
  RoutedNotificationState,
  SessionInboxRecord,
} from "./runtime/notifications.js";
export { discoverSession, findNativeCodexPid, findRolloutPathForPid, findRolloutPathInLsof, readSessionMeta } from "./runtime/codex-session.js";
export type { CodexSessionDiscovery, CodexSessionMeta } from "./runtime/codex-session.js";
export { inferState, ingestSessionSync, parseJsonlEvents, parseJsonlEventsWithStats } from "./runtime/ingest.js";
export type { IngestResult, ParsedCodexEvent } from "./runtime/ingest.js";
export {
  acceptanceCriteriaForTaskSync,
  loopEvidenceCriterion,
  recordAdversarialLoopEvidenceSync,
  recordLoopEvidenceSync,
  recordVisualDiffLoopEvidenceSync,
  LoopEvidenceError,
} from "./runtime/loop-evidence.js";
export type {
  AcceptanceCriterionRecord,
  AcceptanceCriterionSource,
  AcceptanceCriterionStatus,
  LoopEvidenceRecordResult,
  RalphLoopRunRecord,
  VisualDiffLoopEvidenceResult,
} from "./runtime/loop-evidence.js";
export {
  applySetupBundleSync,
  draftSetupBundlePolicy,
  preflightSetupBundle,
  setupBundleForTaskSync,
  setupBundleHash,
} from "./runtime/setup-bundles.js";
export type {
  LoopBackend,
  PlanningBackend,
  PrReviewBackend,
  SetupBundlePolicy,
  SetupBundlePreflight,
  SetupBundleRecord,
  SetupBundleState,
  WhatsNextMode,
} from "./runtime/setup-bundles.js";
export { computeVisualDiffSync, writePngRgba, VisualDiffError } from "./runtime/visual-diff.js";
export type { VisualDiffReport } from "./runtime/visual-diff.js";
export {
  activeBindingForTaskSync,
  bindSessionsSync,
  createTaskSync,
  latestSessionBindingForTaskSync,
  listTasksSync,
  unbindTaskSync,
  TaskLifecycleError,
} from "./runtime/tasks.js";
export type { SessionBindingRecord, TaskBudget, TaskRecord } from "./runtime/tasks.js";
export {
  capturePaneArgs,
  hasSessionArgs,
  isTmuxPermissionError,
  listPanesArgs,
  raiseForTmuxPermissionFailure,
  sendTextCommandSequence,
  sendTextToSessionWithRunner,
  sendTextWithRunner,
  sessionTmuxTarget,
  sessionExists,
  tmuxCommandFailureMessage,
  tmuxPermissionErrorMessage,
  tmuxSession,
  tmuxSessionRunning,
  tmuxTarget,
} from "./runtime/tmux.js";
export type { SendTextResult, TmuxCommandResult, TmuxRunner } from "./runtime/tmux.js";
