import Foundation
import UIKit
import XCTest
@testable import Ember

/// Verifies Chat + Tasks integration on LiveConversationHostModel and SessionTaskStore,
/// including card rendering slots for task/outcome references, relaunch reload, cancellation, and sign-out clearing.
@MainActor
final class LiveConversationHostTasksTests: XCTestCase {
    private var sessions: [URLSession] = []
    private var registrations: [StubURLProtocol.HandlerRegistration] = []
    private var directories: [URL] = []
    private var models: [LiveConversationHostModel] = []

    override func tearDown() async throws {
        for model in models {
            model.suspendForDisappearance()
        }
        models.removeAll()
        try await Task.sleep(nanoseconds: 50_000_000)

        sessions.forEach { $0.invalidateAndCancel() }
        registrations.forEach { $0.remove() }
        for directory in directories { try? FileManager.default.removeItem(at: directory) }
        sessions.removeAll()
        registrations.removeAll()
        directories.removeAll()
        try await super.tearDown()
    }

    func testTaskAndOutcomeReferencesRenderInlineCardsAndReloadAcrossRelaunch() async throws {
        let taskID = "00000000-0000-4000-8000-00000000b311"
        let runningID = "00000000-0000-4000-8000-00000000b312"
        let approvalID = "00000000-0000-4000-8000-00000000b313"
        let agentID = "00000000-0000-4000-8000-00000000b301"

        register { request in
            let path = request.url?.path ?? ""
            if path == "/v1/conversations/\(AuthFixture.conversationID.uuidString.lowercased())/messages" {
                return .json(statusCode: 200, body: """
                {
                  "conversation_id":"\(AuthFixture.conversationID.uuidString.lowercased())",
                  "transcript_epoch":0,
                  "messages":[
                    {"message_id":"55555555-5555-4555-8555-555555555501",
                     "sequence":1,"created_at":"2026-11-15T10:00:00Z",
                     "kind":"user","text":"Extract action items",
                     "client_submission_id":"66666666-6666-4666-8666-666666666601"},
                    {"message_id":"55555555-5555-4555-8555-555555555502",
                     "sequence":2,"created_at":"2026-11-15T10:00:05Z",
                     "kind":"task_reference","task_id":"\(taskID)"},
                    {"message_id":"55555555-5555-4555-8555-555555555503",
                     "sequence":3,"created_at":"2026-11-15T10:01:00Z",
                     "kind":"outcome_reference",
                     "outcome":{"outcome_kind":"meaningful_change","task_id":"\(taskID)"}}
                  ],
                  "next_after":3,"has_more":false
                }
                """)
            }
            if path == "/v1/me/tasks" {
                return .json(statusCode: 200, body: """
                {
                  "tasks":[
                    {"task_id":"\(taskID)","agent_id":"\(agentID)","kind":"notes.action_items",
                     "title":"Q4 Launch Action Items","status":"completed",
                     "attempt_count":1,"result_state":"available",
                     "created_at":"2026-11-15T10:00:05Z","updated_at":"2026-11-15T10:01:00Z","deadline_at":null},
                    {"task_id":"\(runningID)","agent_id":"\(agentID)","kind":"notes.action_items",
                     "title":"Interview Summary","status":"running",
                     "attempt_count":1,"result_state":"pending",
                     "created_at":"2026-11-15T10:02:00Z","updated_at":"2026-11-15T10:02:30Z","deadline_at":null},
                    {"task_id":"\(approvalID)","agent_id":"\(agentID)","kind":"sandbox.python",
                     "title":"Export CSV","status":"waiting_approval",
                     "attempt_count":1,"result_state":"pending",
                     "created_at":"2026-11-15T09:50:00Z","updated_at":"2026-11-15T09:55:00Z","deadline_at":null}
                  ]
                }
                """)
            }
            if path == "/v1/me/tasks/\(taskID)" {
                return .json(statusCode: 200, body: """
                {
                  "task_id":"\(taskID)","agent_id":"\(agentID)","kind":"notes.action_items",
                  "title":"Q4 Launch Action Items","status":"completed",
                  "attempt_count":1,"result_state":"available",
                  "created_at":"2026-11-15T10:00:05Z","updated_at":"2026-11-15T10:01:00Z","deadline_at":null,
                  "result":{
                    "summary_text":"Extracted 2 action items",
                    "detail_text":"1. Ship beta\\n2. Review telemetry",
                    "model_label":"ember-notes-v1",
                    "simulated":false,
                    "produced_at":"2026-11-15T10:01:00Z"
                  }
                }
                """)
            }
            if path == "/v1/tasks/\(taskID)/result" {
                return .json(statusCode: 200, body: """
                {
                  "task_id":"\(taskID)",
                  "task_status":"completed",
                  "result_state":"available",
                  "result":{
                    "summary_text":"Extracted 2 action items",
                    "detail_text":"1. Ship beta\\n2. Review telemetry",
                    "model_label":"ember-notes-v1",
                    "simulated":false,
                    "produced_at":"2026-11-15T10:01:00Z"
                  }
                }
                """)
            }
            if path == "/v1/me/tasks/\(taskID)/events" {
                return .json(statusCode: 200, body: """
                {
                  "task_id":"\(taskID)",
                  "events":[
                    {
                      "task_id":"\(taskID)",
                      "sequence":1,
                      "phase":"completed",
                      "occurred_at":"2026-11-15T10:01:00Z",
                      "trace_id":"00000000-0000-4000-8000-00000000b388",
                      "payload":{"taskKind":"notes.action_items","toStatus":"completed","simulated":false}
                    }
                  ]
                }
                """)
            }
            return .json(statusCode: 404, body: "{}")
        }

        let directory = makeTempDirectory()
        let first = try makeHostModel(directory: directory)
        await first.start()

        XCTAssertEqual(first.selectedTab, .chat)
        XCTAssertEqual(first.screen.timeline.count, 3)

        // task_reference & outcome_reference MUST render as inlineContent cards, not plain activity text
        guard case .inlineContent = first.screen.timeline[1] else {
            return XCTFail("Expected task_reference to render as inline card content")
        }
        guard case .inlineContent = first.screen.timeline[2] else {
            return XCTFail("Expected outcome_reference to render as inline card content")
        }

        let notesUUID = UUID(uuidString: taskID)!
        XCTAssertEqual(first.taskStore.tasksByID[notesUUID]?.kind, .notesActionItems)
        XCTAssertEqual(first.taskStore.resultsByTaskID[notesUUID]?.resultState, .available)
        XCTAssertEqual(first.taskStore.tasks(in: .needsIntervention).count, 1)
        XCTAssertEqual(first.taskStore.tasks(in: .inProgress).count, 1)
        XCTAssertEqual(first.taskStore.tasks(in: .completed).count, 1)
        XCTAssertEqual(first.taskStore.needsInterventionCount, 1)

        // Cold relaunch stand-in: new host instance with no in-memory state must restore tasks & results from Cloud
        let relaunched = try makeHostModel(directory: directory)
        await relaunched.start()

        XCTAssertEqual(relaunched.screen.timeline.count, 3)
        XCTAssertEqual(relaunched.taskStore.tasksByID[notesUUID]?.title, "Q4 Launch Action Items")
        XCTAssertEqual(
            relaunched.taskStore.resultsByTaskID[notesUUID]?.result?.summaryText,
            "Extracted 2 action items"
        )
        await relaunched.taskStore.loadDetail(taskID: notesUUID)
        XCTAssertEqual(relaunched.taskStore.eventsByTaskID[notesUUID]?.count, 1)
    }

    func testCancelAndSignOutClearTaskStoreAndNavigationState() async throws {
        let directory = makeTempDirectory()
        let mockTasks = MockSessionTaskRepository()
        let mockRepo = MockB3ConversationRepository(taskRepository: mockTasks)
        let auth = MockAuthController()
        let model = LiveConversationHostModel(
            repository: mockRepo,
            auth: auth,
            taskRepository: mockTasks,
            isMockMode: true
        )
        models.append(model)

        await model.start()
        XCTAssertEqual(model.taskStore.tasks(in: .inProgress).count, 1)
        XCTAssertEqual(model.taskStore.tasks(in: .needsIntervention).count, 1)
        XCTAssertEqual(model.taskStore.tasks(in: .completed).count, 2)

        model.openTaskFromInbox(MockSessionTaskRepository.runningTaskID)
        XCTAssertEqual(model.selectedTab, .tasks)
        XCTAssertEqual(model.tasksNavigationPath, [MockSessionTaskRepository.runningTaskID])

        await model.taskStore.cancelTask(taskID: MockSessionTaskRepository.runningTaskID)
        XCTAssertEqual(
            model.taskStore.tasksByID[MockSessionTaskRepository.runningTaskID]?.status,
            .cancelled
        )
        XCTAssertEqual(model.taskStore.tasks(in: .inProgress).count, 0)
        XCTAssertEqual(model.taskStore.tasks(in: .completed).count, 3)

        await model.signOut()
        XCTAssertTrue(model.requiresSignIn)
        XCTAssertEqual(model.selectedTab, .chat)
        XCTAssertTrue(model.chatNavigationPath.isEmpty)
        XCTAssertTrue(model.tasksNavigationPath.isEmpty)
        XCTAssertTrue(model.taskStore.orderedTasks.isEmpty)
    }

    func testBackgroundTaskCompletionUpdatesChatOutcomeOnForegroundAndTabReturnWithoutRestart() async throws {
        let runningID = "00000000-0000-4000-8000-00000000b312"
        let runningUUID = UUID(uuidString: runningID)!
        let agentID = "00000000-0000-4000-8000-00000000b301"
        let phaseBox = LockedInt(0)

        register { request in
            let path = request.url?.path ?? ""
            let phase = phaseBox.value
            if path == "/v1/conversations/\(AuthFixture.conversationID.uuidString.lowercased())/messages" {
                var messagesJSON = """
                    {"message_id":"55555555-5555-4555-8555-555555555501",
                     "sequence":1,"created_at":"2026-11-15T10:00:00Z",
                     "kind":"user","text":"Summarize my meeting notes",
                     "client_submission_id":"66666666-6666-4666-8666-666666666601"},
                    {"message_id":"55555555-5555-4555-8555-555555555502",
                     "sequence":2,"created_at":"2026-11-15T10:00:05Z",
                     "kind":"task_reference","task_id":"\(runningID)"}
                    """
                if phase >= 1 {
                    messagesJSON += """
                    ,
                    {"message_id":"55555555-5555-4555-8555-555555555503",
                     "sequence":3,"created_at":"2026-11-15T10:01:00Z",
                     "kind":"outcome_reference",
                     "outcome":{"outcome_kind":"meaningful_change","task_id":"\(runningID)"}}
                    """
                }
                if phase >= 2 {
                    messagesJSON += """
                    ,
                    {"message_id":"55555555-5555-4555-8555-555555555504",
                     "sequence":4,"created_at":"2026-11-15T10:02:00Z",
                     "kind":"ember","text":"Action items are ready above.",
                     "model_label":"ember-notes-v1","simulated":false}
                    """
                }
                let nextAfter = phase >= 2 ? 4 : (phase >= 1 ? 3 : 2)
                return .json(statusCode: 200, body: """
                {
                  "conversation_id":"\(AuthFixture.conversationID.uuidString.lowercased())",
                  "transcript_epoch":0,
                  "messages":[\(messagesJSON)],
                  "next_after":\(nextAfter),"has_more":false
                }
                """)
            }
            if path == "/v1/me/tasks" {
                let status = phase >= 1 ? "completed" : "running"
                let resultState = phase >= 1 ? "available" : "pending"
                return .json(statusCode: 200, body: """
                {
                  "tasks":[
                    {"task_id":"\(runningID)","agent_id":"\(agentID)","kind":"notes.action_items",
                     "title":"Meeting Notes Summary","status":"\(status)",
                     "attempt_count":1,"result_state":"\(resultState)",
                     "created_at":"2026-11-15T10:00:05Z","updated_at":"2026-11-15T10:01:00Z","deadline_at":null}
                  ]
                }
                """)
            }
            if path == "/v1/tasks/\(runningID)/result" && phase >= 1 {
                return .json(statusCode: 200, body: """
                {
                  "task_id":"\(runningID)",
                  "task_status":"completed",
                  "result_state":"available",
                  "result":{
                    "summary_text":"2 action items extracted",
                    "detail_text":"1. Finalize release notes",
                    "model_label":"ember-notes-v1",
                    "simulated":false,
                    "produced_at":"2026-11-15T10:01:00Z"
                  }
                }
                """)
            }
            return .json(statusCode: 404, body: "{}")
        }

        let model = try makeHostModel(directory: makeTempDirectory(), taskPollInterval: .seconds(30))
        model.handleViewAppeared()
        await model.start()

        // Initially Turn completed, Task is running, and Chat shows user message + TaskActivityCard only.
        XCTAssertEqual(model.reply, .idle)
        XCTAssertEqual(model.screen.timeline.count, 2)
        XCTAssertEqual(model.taskStore.tasksByID[runningUUID]?.status, .running)

        // Task completes while app is in background -> returning to active refreshes Conversation + Outcome card.
        model.handleScenePhase(.background)
        phaseBox.value = 1
        model.handleScenePhase(.active)

        for _ in 0..<60 {
            if model.screen.timeline.count == 3,
               model.taskStore.tasksByID[runningUUID]?.status == .completed,
               model.taskStore.resultsByTaskID[runningUUID]?.resultState == .available {
                break
            }
            try await Task.sleep(nanoseconds: 25_000_000)
        }

        XCTAssertEqual(model.screen.timeline.count, 3)
        guard case .inlineContent = model.screen.timeline[2] else {
            return XCTFail("Expected newly emitted outcome_reference to render as OutcomeCard in Chat")
        }
        XCTAssertEqual(model.taskStore.tasksByID[runningUUID]?.status, .completed)
        XCTAssertEqual(model.taskStore.resultsByTaskID[runningUUID]?.result?.summaryText, "2 action items extracted")

        // Switching to Tasks tab and back to Chat also performs a controlled Conversation refresh.
        model.selectedTab = .tasks
        await model.handleTabSelection(.tasks)
        phaseBox.value = 2
        model.selectedTab = .chat
        await model.handleTabSelection(.chat)

        XCTAssertEqual(model.screen.timeline.count, 4)
        XCTAssertEqual(model.command, .idle)
    }

    func testForegroundTaskObserverRefreshesConversationWhenRunningTaskCompletes() async throws {
        let runningID = "00000000-0000-4000-8000-00000000b312"
        let runningUUID = UUID(uuidString: runningID)!
        let agentID = "00000000-0000-4000-8000-00000000b301"
        let completedBox = LockedBool(false)

        register { request in
            let path = request.url?.path ?? ""
            let isCompleted = completedBox.value
            if path == "/v1/conversations/\(AuthFixture.conversationID.uuidString.lowercased())/messages" {
                var messagesJSON = """
                    {"message_id":"55555555-5555-4555-8555-555555555501",
                     "sequence":1,"created_at":"2026-11-15T10:00:00Z",
                     "kind":"user","text":"Watch task completion",
                     "client_submission_id":"66666666-6666-4666-8666-666666666601"},
                    {"message_id":"55555555-5555-4555-8555-555555555502",
                     "sequence":2,"created_at":"2026-11-15T10:00:05Z",
                     "kind":"task_reference","task_id":"\(runningID)"}
                    """
                if isCompleted {
                    messagesJSON += """
                    ,
                    {"message_id":"55555555-5555-4555-8555-555555555503",
                     "sequence":3,"created_at":"2026-11-15T10:01:00Z",
                     "kind":"outcome_reference",
                     "outcome":{"outcome_kind":"meaningful_change","task_id":"\(runningID)"}}
                    """
                }
                return .json(statusCode: 200, body: """
                {
                  "conversation_id":"\(AuthFixture.conversationID.uuidString.lowercased())",
                  "transcript_epoch":0,
                  "messages":[\(messagesJSON)],
                  "next_after":\(isCompleted ? 3 : 2),"has_more":false
                }
                """)
            }
            if path == "/v1/me/tasks" {
                return .json(statusCode: 200, body: """
                {
                  "tasks":[
                    {"task_id":"\(runningID)","agent_id":"\(agentID)","kind":"notes.action_items",
                     "title":"Live Notes Task","status":"\(isCompleted ? "completed" : "running")",
                     "attempt_count":1,"result_state":"\(isCompleted ? "available" : "pending")",
                     "created_at":"2026-11-15T10:00:05Z","updated_at":"2026-11-15T10:01:00Z","deadline_at":null}
                  ]
                }
                """)
            }
            if path == "/v1/tasks/\(runningID)/result" && isCompleted {
                return .json(statusCode: 200, body: """
                {
                  "task_id":"\(runningID)",
                  "task_status":"completed",
                  "result_state":"available",
                  "result":{
                    "summary_text":"Foreground completion synced",
                    "detail_text":null,
                    "model_label":"ember-notes-v1",
                    "simulated":false,
                    "produced_at":"2026-11-15T10:01:00Z"
                  }
                }
                """)
            }
            return .json(statusCode: 404, body: "{}")
        }

        let model = try makeHostModel(directory: makeTempDirectory(), taskPollInterval: .milliseconds(25))
        model.handleViewAppeared()
        await model.start()

        XCTAssertEqual(model.screen.timeline.count, 2)
        completedBox.value = true

        for _ in 0..<60 {
            if model.screen.timeline.count == 3,
               model.taskStore.tasksByID[runningUUID]?.status == .completed,
               model.taskStore.resultsByTaskID[runningUUID]?.resultState == .available {
                break
            }
            try await Task.sleep(nanoseconds: 25_000_000)
        }

        XCTAssertEqual(model.screen.timeline.count, 3)
        XCTAssertEqual(model.taskStore.tasksByID[runningUUID]?.status, .completed)
        XCTAssertEqual(model.taskStore.resultsByTaskID[runningUUID]?.result?.summaryText, "Foreground completion synced")
    }

    func testControlledRefreshPreservesUnknownAcknowledgementAndRejectedDraft() async throws {
        let messageReloadCount = LockedInt(0)
        let rejectNextSend = LockedBool(false)

        register { request in
            let path = request.url?.path ?? ""
            if request.httpMethod == "POST" && path.contains("/messages") {
                if rejectNextSend.value {
                    return .json(statusCode: 409, body: "{\"error\":\"stale_epoch\"}")
                }
                return .failure(URLError(.timedOut))
            }
            if path == "/v1/conversations/\(AuthFixture.conversationID.uuidString.lowercased())/messages" {
                messageReloadCount.increment()
                return .json(statusCode: 200, body: """
                {
                  "conversation_id":"\(AuthFixture.conversationID.uuidString.lowercased())",
                  "transcript_epoch":0,
                  "messages":[],
                  "next_after":0,"has_more":false
                }
                """)
            }
            if path == "/v1/me/tasks" {
                return .json(statusCode: 200, body: "{\"tasks\":[]}")
            }
            return .json(statusCode: 404, body: "{}")
        }

        // Case 1: unknownAcknowledgement must NOT be cleared or overwritten by foreground / tab refresh
        let unknownModel = try makeHostModel(directory: makeTempDirectory())
        unknownModel.handleViewAppeared()
        await unknownModel.start()
        let loadsBeforeUnknown = messageReloadCount.value

        await unknownModel.send("Timed out message")
        XCTAssertEqual(unknownModel.command, .unknownAcknowledgement)

        unknownModel.handleScenePhase(.background)
        unknownModel.handleScenePhase(.active)
        await unknownModel.handleTabSelection(.chat)
        try await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertEqual(unknownModel.command, .unknownAcknowledgement)
        XCTAssertEqual(messageReloadCount.value, loadsBeforeUnknown)

        // Case 2: rejected draft must NOT be overwritten by foreground / tab refresh
        rejectNextSend.value = true
        let rejectedModel = try makeHostModel(directory: makeTempDirectory())
        rejectedModel.handleViewAppeared()
        await rejectedModel.start()
        let loadsBeforeRejected = messageReloadCount.value

        await rejectedModel.send("Draft awaiting review")
        XCTAssertEqual(rejectedModel.command, .rejected)
        XCTAssertEqual(rejectedModel.rejectedDraftText, "Draft awaiting review")

        rejectedModel.handleScenePhase(.background)
        rejectedModel.handleScenePhase(.active)
        await rejectedModel.handleTabSelection(.chat)
        try await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertEqual(rejectedModel.command, .rejected)
        XCTAssertEqual(rejectedModel.rejectedDraftText, "Draft awaiting review")
        XCTAssertEqual(messageReloadCount.value, loadsBeforeRejected)
    }

    func testRefreshFailureSurfacesHonestOfflineNoticeAndClearsOnRecovery() async throws {
        let isOffline = LockedBool(false)
        let phase = LockedInt(0)

        register { request in
            let path = request.url?.path ?? ""
            if path == "/v1/conversations/\(AuthFixture.conversationID.uuidString.lowercased())/messages" {
                if isOffline.value {
                    return .failure(URLError(.notConnectedToInternet))
                }
                if phase.value == 0 {
                    return .json(statusCode: 200, body: """
                    {
                      "conversation_id":"\(AuthFixture.conversationID.uuidString.lowercased())",
                      "transcript_epoch":0,
                      "messages":[
                        {"message_id":"55555555-5555-4555-8555-555555555511",
                         "sequence":1,"created_at":"2026-11-20T08:00:00Z",
                         "kind":"ember","text":"Morning brief ready.",
                         "model_label":"ember-alpha","simulated":false}
                      ],
                      "next_after":1,"has_more":false
                    }
                    """)
                }
                return .json(statusCode: 200, body: """
                {
                  "conversation_id":"\(AuthFixture.conversationID.uuidString.lowercased())",
                  "transcript_epoch":0,
                  "messages":[
                    {"message_id":"55555555-5555-4555-8555-555555555511",
                     "sequence":1,"created_at":"2026-11-20T08:00:00Z",
                     "kind":"ember","text":"Morning brief ready.",
                     "model_label":"ember-alpha","simulated":false},
                    {"message_id":"55555555-5555-4555-8555-555555555512",
                     "sequence":2,"created_at":"2026-11-20T08:05:00Z",
                     "kind":"ember","text":"Follow-up complete.",
                     "model_label":"ember-alpha","simulated":false}
                  ],
                  "next_after":2,"has_more":false
                }
                """)
            }
            if path == "/v1/me/tasks" {
                return isOffline.value
                    ? .failure(URLError(.notConnectedToInternet))
                    : .json(statusCode: 200, body: "{\"tasks\":[]}")
            }
            return .json(statusCode: 404, body: "{}")
        }

        let model = try makeHostModel(directory: makeTempDirectory())
        model.handleViewAppeared()
        await model.start()

        XCTAssertNil(model.refreshErrorMessage)
        XCTAssertEqual(model.screen.timeline.count, 1)

        // Go offline and pull to refresh: existing timeline stays intact and honest notice appears.
        isOffline.value = true
        await model.refreshConversationAndTasks()

        XCTAssertNotNil(model.refreshErrorMessage)
        XCTAssertEqual(model.screen.timeline.count, 1)

        // Recover connectivity and refresh again: notice clears and new message syncs.
        isOffline.value = false
        phase.increment()
        await model.refreshConversationAndTasks()

        XCTAssertNil(model.refreshErrorMessage)
        XCTAssertEqual(model.screen.timeline.count, 2)
    }

    func testRefreshRecoversWhenColdStartFailedOffline() async throws {
        let session = StubSession.make()
        sessions.append(session)
        let transport = try EmberAuthenticatedTransport(
            baseURL: AuthFixture.baseURL,
            client: EmberAPIClient(session: session)
        )
        let api = FakeEmberSessionAPI()
        api.setBootstrapResults([
            .failure(.offline),
            .success(AuthFixture.me()),
        ])
        let auth = LiveAuthSessionCoordinator(dependencies: .init(
            api: api,
            transport: transport,
            store: InMemoryEmberSessionStore(initialRecord: AuthFixture.record()),
            appleSignIn: FakeAppleSignInAuthorizer(behavior: .fail(.appleCancelled)),
            fence: InMemorySessionRecoveryFence(),
            now: { AuthFixture.epoch }
        ))
        let repo = LiveConversationRepository(
            client: LiveB1ConversationClient(auth: auth),
            journal: LiveConversationJournal(directory: makeTempDirectory())
        )
        let taskRepo = LiveB1SessionTaskRepository(auth: auth)
        let model = LiveConversationHostModel(
            repository: repo,
            auth: auth,
            taskRepository: taskRepo
        )
        models.append(model)

        register { request in
            let path = request.url?.path ?? ""
            if path == "/v1/conversations/\(AuthFixture.conversationID.uuidString.lowercased())/messages" {
                return .json(statusCode: 200, body: """
                {
                  "conversation_id":"\(AuthFixture.conversationID.uuidString.lowercased())",
                  "transcript_epoch":0,"messages":[],"next_after":0,"has_more":false
                }
                """)
            }
            if path == "/v1/me/tasks" {
                return .json(statusCode: 200, body: "{\"tasks\":[]}")
            }
            return .json(statusCode: 404, body: "{}")
        }

        await model.start()
        XCTAssertNil(model.profile)
        XCTAssertEqual(
            model.reply,
            .failed(
                message: String(localized: "conversation.live.connection_unavailable", table: "Conversation"),
                retryable: true
            )
        )

        await model.refreshConversationAndTasks()
        XCTAssertNotNil(model.profile)
        XCTAssertNotNil(model.snapshot)
        XCTAssertEqual(model.reply, .idle)
        XCTAssertNil(model.refreshErrorMessage)
    }

    func testAttachFilesAndPhotosRejectsBlockedAndClearsAfterSend() async throws {
        let directory = makeTempDirectory()
        let csvFile = directory.appendingPathComponent("q4 sales.csv")
        let csvData = Data("month,amount\nJan,100\n".utf8)
        try csvData.write(to: csvFile)

        let pdfFile = directory.appendingPathComponent("report.pdf")
        let pdfData = Data("%PDF-1.4\n".utf8)
        try pdfData.write(to: pdfFile)

        let blockedFile = directory.appendingPathComponent("malicious.html")
        try Data("<script>alert(1)</script>".utf8).write(to: blockedFile)

        let csvUploadID = "00000000-0000-4000-8000-00000000c111"
        let pdfUploadID = "00000000-0000-4000-8000-00000000c222"
        let sha = String(repeating: "c", count: 64)
        let capturedSendBody = RequestRecorder()

        register { request in
            let path = request.url?.path ?? ""
            if request.httpMethod == "POST" && path == "/v1/me/uploads" {
                let bodyText = request.httpBody.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                if bodyText.contains("report.pdf") {
                    return .json(statusCode: 201, body: """
                    {
                      "upload_id":"\(pdfUploadID)",
                      "filename":"report.pdf",
                      "media_type":"application/pdf",
                      "size":\(pdfData.count),
                      "sha256":"\(sha)",
                      "expires_at":"2026-11-17T00:00:00Z",
                      "created_at":"2026-11-16T00:00:00Z"
                    }
                    """)
                }
                return .json(statusCode: 201, body: """
                {
                  "upload_id":"\(csvUploadID)",
                  "filename":"q4_sales.csv",
                  "media_type":"text/csv",
                  "size":\(csvData.count),
                  "sha256":"\(sha)",
                  "expires_at":"2026-11-17T00:00:00Z",
                  "created_at":"2026-11-16T00:00:00Z"
                }
                """)
            }
            if request.httpMethod == "POST" && path.contains("/messages") {
                capturedSendBody.record(request)
                let payload = request.httpBody.flatMap {
                    try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
                } ?? [:]
                let submissionID = (payload["client_submission_id"] as? String)
                    ?? "66666666-6666-4666-8666-666666666611"
                return .json(statusCode: 201, body: """
                {
                  "message":{
                    "message_id":"55555555-5555-4555-8555-555555555511",
                    "conversation_id":"\(AuthFixture.conversationID.uuidString.lowercased())",
                    "sequence":1,"created_at":"2026-11-16T00:00:00Z",
                    "kind":"user","text":"Summarize revenue",
                    "client_submission_id":"\(submissionID)"
                  },
                  "turn":{"turn_id":"88888888-8888-4888-8888-888888888811",
                          "status":"running","created_at":"2026-11-16T00:00:00Z"},
                  "transcript_epoch":0
                }
                """)
            }
            if path == "/v1/conversations/\(AuthFixture.conversationID.uuidString.lowercased())/messages" {
                return .json(statusCode: 200, body: """
                {
                  "conversation_id":"\(AuthFixture.conversationID.uuidString.lowercased())",
                  "transcript_epoch":0,
                  "messages":[],
                  "next_after":0,"has_more":false
                }
                """)
            }
            if path == "/v1/me/tasks" {
                return .json(statusCode: 200, body: "{\"tasks\":[]}")
            }
            return .json(statusCode: 404, body: "{}")
        }

        let model = try makeHostModel(directory: directory)
        await model.start()

        await model.attachFile(from: blockedFile)
        XCTAssertTrue(model.stagedAttachments.isEmpty)
        XCTAssertNotNil(model.attachmentError)

        await model.attachFile(from: csvFile)
        XCTAssertNil(model.attachmentError)
        XCTAssertEqual(model.stagedAttachments.count, 1)
        XCTAssertEqual(model.screen.attachments.first?.filename, "q4_sales.csv")

        await model.attachFile(from: pdfFile)
        XCTAssertNil(model.attachmentError)
        XCTAssertEqual(model.stagedAttachments.count, 2)
        XCTAssertEqual(model.screen.attachments.last?.filename, "report.pdf")

        await model.send("Summarize revenue")
        XCTAssertTrue(model.stagedAttachments.isEmpty)
        let req = try XCTUnwrap(capturedSendBody.requests.first)
        let body = try XCTUnwrap(req.httpBody)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(obj["attachment_ids"] as? [String], [csvUploadID, pdfUploadID])
    }

    func testAttachFileCompressesOversizedVisionImageToJpegUnder4MiB() async throws {
        let directory = makeTempDirectory()
        let largePngFile = directory.appendingPathComponent("diagram.png")
        let pngData = try makeNoisyPngData(width: 1400, height: 1400)
        XCTAssertGreaterThan(pngData.count, B3AttachmentLimits.maxVisionImageBytes)
        XCTAssertLessThanOrEqual(pngData.count, B3AttachmentLimits.maxFileBytes)
        try pngData.write(to: largePngFile)

        let uploadID = "00000000-0000-4000-8000-00000000c333"
        let sha = String(repeating: "d", count: 64)
        let capturedUploads = RequestRecorder()

        register { request in
            let path = request.url?.path ?? ""
            if request.httpMethod == "POST" && path == "/v1/me/uploads" {
                capturedUploads.record(request)
                let bodyData = request.httpBody ?? Data()
                let parsedSize = Self.multipartFileByteCount(in: bodyData) ?? bodyData.count
                return .json(statusCode: 201, body: """
                {
                  "upload_id":"\(uploadID)",
                  "filename":"diagram.jpg",
                  "media_type":"image/jpeg",
                  "size":\(parsedSize),
                  "sha256":"\(sha)",
                  "expires_at":"2026-11-17T00:00:00Z",
                  "created_at":"2026-11-16T00:00:00Z"
                }
                """)
            }
            if path == "/v1/conversations/\(AuthFixture.conversationID.uuidString.lowercased())/messages" {
                return .json(statusCode: 200, body: """
                {
                  "conversation_id":"\(AuthFixture.conversationID.uuidString.lowercased())",
                  "transcript_epoch":0,
                  "messages":[],
                  "next_after":0,"has_more":false
                }
                """)
            }
            if path == "/v1/me/tasks" {
                return .json(statusCode: 200, body: "{\"tasks\":[]}")
            }
            return .json(statusCode: 404, body: "{}")
        }

        let model = try makeHostModel(directory: directory)
        await model.start()

        await model.attachFile(from: largePngFile)
        XCTAssertNil(model.attachmentError)
        XCTAssertEqual(model.stagedAttachments.count, 1)
        let staged = try XCTUnwrap(model.stagedAttachments.first)
        XCTAssertEqual(staged.filename, "diagram.jpg")
        XCTAssertEqual(staged.mediaType, "image/jpeg")
        XCTAssertLessThanOrEqual(staged.sizeBytes, B3AttachmentLimits.maxVisionImageBytes)

        let uploadReq = try XCTUnwrap(capturedUploads.requests.first)
        let uploadBody = try XCTUnwrap(uploadReq.httpBody)
        let bodyPrefix = String(decoding: uploadBody.prefix(512), as: UTF8.self)
        XCTAssertTrue(bodyPrefix.contains("filename=\"diagram.jpg\""))
        XCTAssertTrue(bodyPrefix.contains("image/jpeg"))
    }

    private func makeNoisyPngData(width: Int, height: Int) throws -> Data {
        var bytes = [UInt8](repeating: 255, count: width * height * 4)
        var state: UInt32 = 0x1234_5678
        for index in stride(from: 0, to: bytes.count, by: 4) {
            state ^= state << 13
            state ^= state >> 17
            state ^= state << 5
            bytes[index] = UInt8(truncatingIfNeeded: state)
            bytes[index + 1] = UInt8(truncatingIfNeeded: state >> 8)
            bytes[index + 2] = UInt8(truncatingIfNeeded: state >> 16)
            bytes[index + 3] = 255
        }
        let provider = try XCTUnwrap(CGDataProvider(data: Data(bytes) as CFData))
        let cgImage = try XCTUnwrap(
            CGImage(
                width: width,
                height: height,
                bitsPerComponent: 8,
                bitsPerPixel: 32,
                bytesPerRow: width * 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue),
                provider: provider,
                decode: nil,
                shouldInterpolate: false,
                intent: .defaultIntent
            )
        )
        return try XCTUnwrap(UIImage(cgImage: cgImage).pngData())
    }

    private nonisolated static func multipartFileByteCount(in body: Data) -> Int? {
        guard let markerRange = body.range(of: Data("Content-Type: image/jpeg\r\n\r\n".utf8)),
              let tailRange = body.range(of: Data("\r\n--EmberBoundary-".utf8), options: [], in: markerRange.upperBound..<body.endIndex)
        else {
            return nil
        }
        return tailRange.lowerBound - markerRange.upperBound
    }

    func testEmptyLiveConversationProvidesStarterPromptsAndPendingSendAppearsImmediatelyUntilCommitted() async throws {
        let directory = makeTempDirectory()
        let conversationID = AuthFixture.conversationID.uuidString.lowercased()
        let messageText = "Remember my morning brief preference"
        let sendAttempts = LockedInt(0)

        register { request in
            let path = request.url?.path ?? ""
            if request.httpMethod == "GET", path == "/v1/me" {
                return .json(statusCode: 200, body: AuthFixture.meJSON)
            }
            if request.httpMethod == "GET", path == "/v1/me/tasks" {
                return .json(statusCode: 200, body: #"{"tasks":[]}"#)
            }
            if request.httpMethod == "GET", path == "/v1/conversations/\(conversationID)/messages" {
                if sendAttempts.value >= 2 {
                    return .json(statusCode: 200, body: """
                    {
                      "conversation_id":"\(conversationID)",
                      "transcript_epoch":0,
                      "messages":[
                        {"message_id":"55555555-5555-4555-8555-555555555599",
                         "sequence":1,"created_at":"2026-11-21T10:00:00Z","kind":"user",
                         "text":"\(messageText)","client_submission_id":"66666666-6666-4666-8666-666666666699"}
                      ],
                      "next_after":1,"has_more":false
                    }
                    """)
                }
                return .json(statusCode: 200, body: """
                {
                  "conversation_id":"\(conversationID)",
                  "transcript_epoch":0,
                  "messages":[],
                  "next_after":0,"has_more":false
                }
                """)
            }
            if request.httpMethod == "POST", path == "/v1/conversations/\(conversationID)/messages" {
                sendAttempts.increment()
                if sendAttempts.value == 1 {
                    return .failure(URLError(.timedOut))
                }
                let body = request.httpBody ?? Data()
                let obj = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
                let clientID = (obj?["client_submission_id"] as? String) ?? "66666666-6666-4666-8666-666666666699"
                return .json(statusCode: 201, body: """
                {
                  "message":{
                    "message_id":"55555555-5555-4555-8555-555555555599",
                    "conversation_id":"\(conversationID)",
                    "sequence":1,"created_at":"2026-11-21T10:00:00Z","kind":"user",
                    "text":"\(messageText)","client_submission_id":"\(clientID)"
                  },
                  "turn":{"turn_id":"88888888-8888-4888-8888-888888888899","status":"running","created_at":"2026-11-21T10:00:00Z"},
                  "transcript_epoch":0
                }
                """)
            }
            if path.contains("/message-submissions/") {
                return .json(statusCode: 404, body: "{}")
            }
            if path.contains("/turns/") {
                return .json(statusCode: 200, body: """
                {
                  "turn_id":"88888888-8888-4888-8888-888888888899",
                  "conversation_id":"\(conversationID)",
                  "source_message_id":"55555555-5555-4555-8555-555555555599",
                  "status":"running",
                  "created_at":"2026-11-21T10:00:00Z",
                  "updated_at":"2026-11-21T10:00:01Z"
                }
                """)
            }
            return .json(statusCode: 404, body: "{}")
        }

        let model = try makeHostModel(directory: directory)
        await model.start()

        // Empty live conversation provides starter prompts
        XCTAssertEqual(model.screen.suggestedPrompts.count, 3)
        XCTAssertTrue(model.screen.showsEmptyState)

        // Timed-out send preserves a visible pending bubble until reconciled
        await model.send(messageText)
        XCTAssertEqual(model.pendingOutgoingText, messageText)
        XCTAssertEqual(model.screen.timeline.count, 1)
        if case .message(let pendingBubble) = model.screen.timeline.first {
            XCTAssertEqual(pendingBubble.text, messageText)
            XCTAssertEqual(pendingBubble.accessibilityIdentifierOverride, "conversation-message-user-pending")
            XCTAssertNotNil(pendingBubble.deliveryNote)
        } else {
            XCTFail("Expected pending outgoing bubble in timeline")
        }

        await model.retry()
        XCTAssertNil(model.pendingOutgoingText)
        XCTAssertEqual(model.screen.timeline.count, 1)
        if case .message(let committedBubble) = model.screen.timeline.first {
            XCTAssertEqual(committedBubble.text, messageText)
            XCTAssertNil(committedBubble.accessibilityIdentifierOverride)
            XCTAssertNil(committedBubble.deliveryNote)
        } else {
            XCTFail("Expected committed user bubble in timeline")
        }
    }

    func testAllowlist403SignInSurfacesClearAllowlistMessageAndNonRetryableErrorCanBeDismissed() async throws {
        let directory = makeTempDirectory()
        let conversationID = AuthFixture.conversationID.uuidString.lowercased()
        let session = StubSession.make()
        sessions.append(session)
        let api = FakeEmberSessionAPI()
        api.setCreateSessionResult(.failure(.accessDenied))
        let transport = try EmberAuthenticatedTransport(
            baseURL: AuthFixture.baseURL,
            client: EmberAPIClient(session: session)
        )
        let auth = LiveAuthSessionCoordinator(dependencies: .init(
            api: api,
            transport: transport,
            store: InMemoryEmberSessionStore(initialRecord: nil),
            appleSignIn: FakeAppleSignInAuthorizer(
                behavior: .succeed(
                    AppleSignInCredential(
                        identityToken: "token",
                        rawNonce: "nonce",
                        attemptID: UUID()
                    )
                )
            ),
            fence: InMemorySessionRecoveryFence(),
            now: { AuthFixture.epoch }
        ))

        register { request in
            let path = request.url?.path ?? ""
            if path == "/v1/me/tasks" {
                return .json(statusCode: 200, body: #"{"tasks":[]}"#)
            }
            if request.httpMethod == "GET", path == "/v1/conversations/\(conversationID)/messages" {
                return .json(statusCode: 200, body: """
                {
                  "conversation_id":"\(conversationID)",
                  "transcript_epoch":0,
                  "messages":[],
                  "next_after":0,"has_more":false
                }
                """)
            }
            if request.httpMethod == "POST", path == "/v1/conversations/\(conversationID)/messages" {
                return .json(statusCode: 409, body: "{}")
            }
            return .json(statusCode: 404, body: "{}")
        }

        let repo = LiveConversationRepository(
            client: LiveB1ConversationClient(auth: auth),
            journal: LiveConversationJournal(directory: directory)
        )
        let model = LiveConversationHostModel(repository: repo, auth: auth)
        models.append(model)

        await model.start()
        XCTAssertTrue(model.requiresSignIn)

        await model.signIn()
        XCTAssertEqual(
            model.signInErrorMessage,
            String(localized: "conversation.live.sign_in_not_allowlisted", table: "Conversation")
        )
        XCTAssertEqual(
            model.status,
            String(localized: "conversation.live.sign_in_not_allowlisted", table: "Conversation")
        )
        XCTAssertTrue(model.requiresSignIn)

        // Second sign-in succeeds, then a 409 conflict error can be dismissed cleanly
        api.setCreateSessionResult(.success(AuthFixture.sessionResponse()))
        await model.signIn()
        XCTAssertFalse(model.requiresSignIn)
        XCTAssertNil(model.signInErrorMessage)

        await model.send("conflict test")
        XCTAssertEqual(model.command, ConversationCommandStatus.rejected)
        XCTAssertEqual(model.rejectedDraftText, "conflict test")
        XCTAssertNil(model.pendingOutgoingText)

        model.dismissReplyError()
        XCTAssertEqual(model.reply, ConversationReplyState.idle)
        XCTAssertEqual(model.command, ConversationCommandStatus.idle)
        XCTAssertNil(model.status)
    }

    func testRetryResetsStuckErrorStateWhenReloadSucceedsWithNoPendingOrActiveTurn() async throws {
        let directory = makeTempDirectory()
        let conversationID = AuthFixture.conversationID.uuidString.lowercased()
        let messageAttempts = LockedInt(0)

        register { request in
            let path = request.url?.path ?? ""
            if request.httpMethod == "GET", path == "/v1/me/tasks" {
                return .json(statusCode: 200, body: #"{"tasks":[]}"#)
            }
            if request.httpMethod == "GET", path == "/v1/conversations/\(conversationID)/messages" {
                messageAttempts.increment()
                if messageAttempts.value <= 2 {
                    return .failure(URLError(.timedOut))
                }
                return .json(statusCode: 200, body: """
                {
                  "conversation_id":"\(conversationID)",
                  "transcript_epoch":0,
                  "messages":[],
                  "next_after":0,"has_more":false
                }
                """)
            }
            return .json(statusCode: 404, body: "{}")
        }

        let model = try makeHostModel(directory: directory)
        await model.start()
        XCTAssertEqual(model.command, .unknownAcknowledgement)
        if case .failed(_, retryable: true) = model.reply {
            // Expected initial load failure state
        } else {
            return XCTFail("Expected retryable failure after initial load error")
        }

        await model.retry()
        XCTAssertEqual(model.command, .idle)
        XCTAssertEqual(model.reply, .idle)
        XCTAssertNil(model.refreshErrorMessage)
        XCTAssertNil(model.status)
    }

    private func makeHostModel(
        directory: URL,
        taskPollInterval: Duration = .seconds(2)
    ) throws -> LiveConversationHostModel {
        let session = StubSession.make()
        sessions.append(session)
        let transport = try EmberAuthenticatedTransport(
            baseURL: AuthFixture.baseURL,
            client: EmberAPIClient(session: session)
        )
        let auth = LiveAuthSessionCoordinator(dependencies: .init(
            api: FakeEmberSessionAPI(),
            transport: transport,
            store: InMemoryEmberSessionStore(initialRecord: AuthFixture.record()),
            appleSignIn: FakeAppleSignInAuthorizer(behavior: .fail(.appleCancelled)),
            fence: InMemorySessionRecoveryFence(),
            now: { AuthFixture.epoch }
        ))
        let repo = LiveConversationRepository(
            client: LiveB1ConversationClient(auth: auth),
            journal: LiveConversationJournal(directory: directory)
        )
        let taskRepo = LiveB1SessionTaskRepository(auth: auth)
        let model = LiveConversationHostModel(
            repository: repo,
            auth: auth,
            taskRepository: taskRepo,
            taskPollInterval: taskPollInterval
        )
        models.append(model)
        return model
    }

    private func makeTempDirectory() -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("b3-host-tasks-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        directories.append(dir)
        return dir
    }

    private func register(_ handler: @escaping StubURLProtocol.Handler) {
        registrations.append(StubURLProtocol.register(handler, forHost: AuthFixture.baseURL.host!))
    }
}

private final class LockedBool: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: Bool

    init(_ initial: Bool) {
        self.storage = initial
    }

    var value: Bool {
        get { lock.withLock { storage } }
        set { lock.withLock { storage = newValue } }
    }
}

private final class LockedInt: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: Int

    init(_ initial: Int) {
        self.storage = initial
    }

    var value: Int {
        get { lock.withLock { storage } }
        set { lock.withLock { storage = newValue } }
    }

    func increment() {
        lock.withLock { storage += 1 }
    }
}
