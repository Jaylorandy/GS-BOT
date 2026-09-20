class TaskCancelledError extends Error {
  constructor(message = 'Task cancelled by user') {
    super(message);
    this.name = 'TaskCancelledError';
    this.code = 'TASK_CANCELLED';
  }
}

const activeTaskSnapshots = new Map();
const taskHistoryBySenderId = new Map();
const TASK_HISTORY_LIMIT = 24;

function getTaskKey(sender, taskType) {
  return `${sender.id}:${taskType}`;
}

function getTaskLabel(taskType = '') {
  const normalized = String(taskType || '').trim().toLowerCase();
  const labels = {
    slides: 'Slides Maker',
    scrape: 'Scraper',
    annotate: 'Excel Annotator',
    analysis: 'Product Analysis',
    'pdf-squeezer': 'PDF Squeezer',
    'rag-sync': 'Knowledge Sync',
  };
  return labels[normalized] || String(taskType || 'Task');
}

function cloneSnapshot(snapshot = {}) {
  return {
    ...snapshot,
  };
}

function sendTaskCenterUpdate(sender, payload = {}) {
  try {
    sender?.send?.('task-center-update', payload);
  } catch {
    // Ignore UI update failures.
  }
}

function writeTaskHistory(senderId, snapshot = {}) {
  const key = String(senderId || '');
  if (!key) {
    return;
  }

  const nextHistory = taskHistoryBySenderId.get(key) || [];
  const filtered = nextHistory.filter((entry) => entry.id !== snapshot.id);
  filtered.unshift(cloneSnapshot(snapshot));
  taskHistoryBySenderId.set(key, filtered.slice(0, TASK_HISTORY_LIMIT));
}

function createTaskSnapshot(sender, taskType) {
  const nowIso = new Date().toISOString();
  return {
    id: getTaskKey(sender, taskType),
    senderId: sender.id,
    taskType,
    label: getTaskLabel(taskType),
    status: 'running',
    startedAt: nowIso,
    updatedAt: nowIso,
    endedAt: '',
    inputPath: '',
    outputPath: '',
    summary: '',
    cacheMode: '',
    error: '',
    cancelled: false,
  };
}

function updateTaskSnapshot(sender, taskType, patch = {}) {
  const taskKey = getTaskKey(sender, taskType);
  const current = activeTaskSnapshots.get(taskKey);
  if (!current) {
    return null;
  }

  const nextSnapshot = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  activeTaskSnapshots.set(taskKey, nextSnapshot);
  sendTaskCenterUpdate(sender, {
    type: 'update',
    task: cloneSnapshot(nextSnapshot),
  });
  return nextSnapshot;
}

function finalizeTaskSnapshot(sender, taskType, patch = {}) {
  const taskKey = getTaskKey(sender, taskType);
  const current = activeTaskSnapshots.get(taskKey);
  if (!current) {
    return null;
  }

  const nextSnapshot = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
  };
  activeTaskSnapshots.delete(taskKey);
  writeTaskHistory(sender.id, nextSnapshot);
  sendTaskCenterUpdate(sender, {
    type: 'finished',
    task: cloneSnapshot(nextSnapshot),
  });
  return nextSnapshot;
}

function listManagedTasksForSender(sender) {
  const senderId = String(sender?.id || '');
  const active = [...activeTaskSnapshots.values()]
    .filter((snapshot) => String(snapshot.senderId) === senderId)
    .map((snapshot) => cloneSnapshot(snapshot));
  const history = (taskHistoryBySenderId.get(senderId) || []).map((snapshot) => cloneSnapshot(snapshot));
  return { active, history };
}

function clearTaskHistoryForSender(sender) {
  const senderId = String(sender?.id || '');
  if (!senderId) {
    return { cleared: false, removedHistory: 0 };
  }

  const removedHistory = (taskHistoryBySenderId.get(senderId) || []).length;
  taskHistoryBySenderId.set(senderId, []);
  return { cleared: true, removedHistory };
}

function createTaskController(sender, taskType) {
  const cancelHandlers = new Set();

  return {
    sender,
    taskType,
    cancelled: false,
    onCancel(handler) {
      if (typeof handler !== 'function') {
        return () => {};
      }
      cancelHandlers.add(handler);
      return () => cancelHandlers.delete(handler);
    },
    cancel() {
      if (this.cancelled) {
        return;
      }
      this.cancelled = true;
      for (const handler of cancelHandlers) {
        try {
          handler();
        } catch (error) {
          console.error(`[TASK ${taskType}] cancel handler failed:`, error);
        }
      }
    },
    throwIfCancelled() {
      if (this.cancelled) {
        throw new TaskCancelledError();
      }
    },
  };
}

async function runManagedTask(event, taskType, executor, activeTaskControllers) {
  const taskKey = getTaskKey(event.sender, taskType);
  const existingTask = activeTaskControllers.get(taskKey);
  if (existingTask && !existingTask.cancelled) {
    return {
      success: false,
      error: 'A task is already running in this workspace.',
    };
  }

  const controller = createTaskController(event.sender, taskType);
  activeTaskControllers.set(taskKey, controller);
  const snapshot = createTaskSnapshot(event.sender, taskType);
  activeTaskSnapshots.set(taskKey, snapshot);
  sendTaskCenterUpdate(event.sender, {
    type: 'started',
    task: cloneSnapshot(snapshot),
  });

  try {
    const result = await executor(controller);
    finalizeTaskSnapshot(event.sender, taskType, {
      status: result?.cancelled ? 'cancelled' : 'completed',
      cancelled: Boolean(result?.cancelled),
      outputPath: String(result?.outputPath || '').trim(),
      error: result?.success === false ? String(result?.error || '').trim() : '',
    });
    return result;
  } catch (error) {
    if (error instanceof TaskCancelledError || error?.code === 'TASK_CANCELLED') {
      finalizeTaskSnapshot(event.sender, taskType, {
        status: 'cancelled',
        cancelled: true,
        error: error.message || 'Task cancelled by user',
      });
      return {
        success: false,
        cancelled: true,
        error: error.message || 'Task cancelled by user',
      };
    }
    finalizeTaskSnapshot(event.sender, taskType, {
      status: 'failed',
      error: error?.message || String(error),
    });
    throw error;
  } finally {
    if (activeTaskControllers.get(taskKey) === controller) {
      activeTaskControllers.delete(taskKey);
    }
  }
}

module.exports = {
  TaskCancelledError,
  clearTaskHistoryForSender,
  createTaskController,
  getTaskKey,
  listManagedTasksForSender,
  runManagedTask,
  updateTaskSnapshot,
};
