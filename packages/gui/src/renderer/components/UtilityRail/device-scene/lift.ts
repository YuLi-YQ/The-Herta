/**
 * The 3D device's lift spring (ADR 0057 §2), ported from the study's
 * device-lift.js. The flat card lifts by a CSS transition; the scene lifts
 * the mesh, its shadow and the room's light exchange, so it needs a
 * frame-rate-stable spring instead. Critically damped: follows the hand
 * without overshoot and settles on release with no decorative bounce.
 *
 * The TARGET comes from the production drag hook (`useDragToLift`: 8 px dead
 * zone, 12 px ceiling, the chance gate and the easter egg untouched); this
 * only smooths the path to it.
 */

export const MAX_LIFT_PX = 12;

export interface LiftPose {
  /** Current lift in CSS px. */
  liftPx: number;
  /** Where the hand (or release) wants it. */
  targetLiftPx: number;
  /** px / s. */
  velocityPx: number;
}

export function createLiftPose(): LiftPose {
  return { liftPx: 0, targetLiftPx: 0, velocityPx: 0 };
}

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

/**
 * Advance the spring by `dt` seconds. `held` (a drag in progress) stiffens
 * it slightly so the device tracks the hand; release is a touch slower.
 * Returns true while the pose is still moving.
 */
export function advanceLift(
  pose: LiftPose,
  dt: number,
  held: boolean,
): boolean {
  const omega = held ? 24 : 17;
  const displacement = pose.liftPx - pose.targetLiftPx;
  const c = pose.velocityPx + omega * displacement;
  const decay = Math.exp(-omega * dt);
  const next = pose.targetLiftPx + (displacement + c * dt) * decay;
  pose.velocityPx = (pose.velocityPx - omega * c * dt) * decay;
  pose.liftPx = clamp(next, 0, MAX_LIFT_PX);
  if (next !== pose.liftPx) pose.velocityPx = 0;
  if (
    Math.abs(pose.liftPx - pose.targetLiftPx) < 0.005 &&
    Math.abs(pose.velocityPx) < 0.02
  ) {
    pose.liftPx = pose.targetLiftPx;
    pose.velocityPx = 0;
  }
  return pose.liftPx !== pose.targetLiftPx || pose.velocityPx !== 0;
}
