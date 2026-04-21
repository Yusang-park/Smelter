/**
 * mode-classifier-stub.mjs — Deterministic test stub for classifyMode.
 *
 * Pure prompt-lookup table: the point of this file is to REPLACE the real
 * Claude LLM with a fixed set of canned responses in the test harness.
 * Do NOT implement language/keyword matching here — that would re-create
 * the regex classifier that the v2.4.9 refactor removed.
 *
 * Wire-up: `SMELTER_MODE_CLASSIFIER_MODULE=<this-path>` in test setup;
 * `scripts/lib/subagent-classifier.mjs::invokeModeClassifier` then imports
 * this module instead of spawning the real Claude CLI.
 *
 * Add new prompts here when a new test case introduces one. Never add
 * regex logic — hardcoded strings only.
 */

const LOOKUP = Object.freeze({
  // keyword-detector.test.mjs — chain tests
  '확인하고 수정해줘': { mode: 'investigate', chained_modes: ['investigate', 'fix'] },
  '설계하고 구현해줘': { mode: 'think', chained_modes: ['think', 'implement'] },

  // keyword-detector.test.mjs — single-mode tests
  '버그 고쳐줘': { mode: 'fix', chained_modes: null },

  // keyword-detector.test.mjs — CSS session-scoping tests.
  '사이드바 폭 파악해줘': { mode: 'investigate', chained_modes: null },
  '이거 더 자세히 분석해줘': { mode: 'fix', chained_modes: null },
  'OAuth 부분 추가로 확인': { mode: 'fix', chained_modes: null },
  '새 feature 만들자 — 결제 모듈': { mode: 'think', chained_modes: null },
  '사이드바 분석': { mode: 'investigate', chained_modes: null },
  '로그인 분석': { mode: 'investigate', chained_modes: null },
  '이거 이어서': { mode: 'fix', chained_modes: null },

  // workflow-scenarios.test.mjs — SCENARIO 13 spec-coherence cases (§1-2).
  // v3: simple_fix mode removed; CSS/typo-surface utterances now classify
  // as `fix` (magic keyword sets exempt.tdd).
  '텍스트 수정해줘': { mode: 'fix', chained_modes: null },
  'css 색깔 바꿔': { mode: 'fix', chained_modes: null },
  '오타 고쳐': { mode: 'fix', chained_modes: null },
  '이거 안 돌아가': { mode: 'fix', chained_modes: null },
  'fix the login error': { mode: 'fix', chained_modes: null },
  '파악해줘': { mode: 'investigate', chained_modes: null },
  '확인 좀 해줘': { mode: 'investigate', chained_modes: null },
  'analyze this function': { mode: 'investigate', chained_modes: null },
  '점검해': { mode: 'verify', chained_modes: null },
  '테스트 해봐': { mode: 'verify', chained_modes: null },
  'run the tests': { mode: 'verify', chained_modes: null },
  '설계해줘': { mode: 'think', chained_modes: null },
  '리팩토링할거야': { mode: 'think', chained_modes: null },
  '새로운 기능 만들거야': { mode: 'think', chained_modes: null },
  '다크모드 토글 추가해줘': { mode: 'implement', chained_modes: null },
  '덧붙여서 이메일 알림도': { mode: 'implement', chained_modes: null },
  'extend the auth flow': { mode: 'implement', chained_modes: null },

  // mode-classifier.test.mjs own unit tests inject their own stub, so those
  // prompts do not need entries here.
});

export function classifyMode(prompt) {
  const text = String(prompt || '').trim();
  const hit = LOOKUP[text];
  if (hit) {
    return {
      mode: hit.mode,
      chained_modes: hit.chained_modes,
      trigger: `stub:${hit.mode}`,
      passthrough: false,
    };
  }
  // Unknown prompt — return a safe default so the test still completes and
  // the authoring developer notices the miss (default fix mode keeps the
  // state-seed path exercised without triggering investigate-reseed).
  return {
    mode: 'fix',
    chained_modes: null,
    trigger: 'stub:unmapped-default',
    passthrough: false,
  };
}
