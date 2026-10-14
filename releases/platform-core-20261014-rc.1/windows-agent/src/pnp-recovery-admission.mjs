import { isPnpRecoveryTargetDue, normalizePnpRecoveryTargetState } from './pnp-recovery-policy.mjs';

// Selection happens before asynchronous probes. Never execute a plan whose
// state/observation was replaced while awaiting them, even if it is due now.
export function pnpRecoveryAdmissionReason({
  currentState, plannedState, currentObservation, plannedObservation,
  inventoryReady, busy, now = Date.now()
}) {
  if (busy) return 'target_busy';
  if (!inventoryReady) return 'physical_inventory_unavailable';
  const state = normalizePnpRecoveryTargetState(currentState);
  if (!isPnpRecoveryTargetDue(state, now)) {
    return state.inProgress ? 'target_recovery_in_progress' : 'target_recovery_cooldown';
  }
  if (currentState !== plannedState) return 'target_recovery_state_changed';
  if (!currentObservation || currentObservation !== plannedObservation) return 'target_recovery_observation_changed';
  return '';
}
