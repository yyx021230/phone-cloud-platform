export function createStateRepositories(state) {
  return {
    agents: {
      all: () => state.windowsAgents || [],
      findById: (agentId) => (state.windowsAgents || []).find((agent) => agent.agentId === agentId) || null
    },
    devices: {
      all: () => state.devices || [],
      findById: (deviceId) => (state.devices || []).find((device) => device.deviceId === deviceId) || null
    },
    sms: {
      allMessages: () => state.smsMessages || [],
      messagesForDevice: (deviceId) => (state.smsMessages || []).filter((message) => message.deviceId === deviceId)
    },
    windowsTasks: {
      all: () => state.windowsTasks || [],
      findById: (taskId) => (state.windowsTasks || []).find((task) => task.taskId === taskId) || null
    },
    xhsTasks: {
      all: () => state.xhsQrTasks || [],
      findById: (taskId) => (state.xhsQrTasks || []).find((task) => task.taskId === taskId) || null
    }
  };
}
