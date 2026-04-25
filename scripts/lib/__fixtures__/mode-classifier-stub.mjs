/**
 * mode-classifier-stub.mjs — Deterministic test stub for classifyMode.
 *
 * Pure prompt-lookup table: replaces the real Claude LLM with canned v2 responses.
 * Do NOT implement language/keyword matching here — that would re-create the
 * regex classifier that the v2.4.9 refactor removed.
 *
 * v3.2: returns extended shape { schema_version:2, mode, chained_modes, trigger,
 * passthrough, target_type, exempt, skip_brainstorm }.
 */

const surfaceText   = { target_type: 'text', exempt: { tdd: true, e2e: true }, skip_brainstorm: false };
const surfaceDesign = { target_type: 'design', exempt: { tdd: true, e2e: false }, skip_brainstorm: false };
const surfaceExt    = { target_type: 'extend_existing', exempt: null, skip_brainstorm: true };
const surfaceBug    = { target_type: 'bug_fix', exempt: null, skip_brainstorm: false };
const surfaceNone   = { target_type: null, exempt: null, skip_brainstorm: false };

const LOOKUP = Object.freeze({
  // chain tests
  '확인하고 수정해줘': { mode: 'explore', chained_modes: ['explore', 'fix'], ...surfaceNone },
  '설계하고 구현해줘': { mode: 'brainstorm', chained_modes: ['brainstorm', 'implement'], ...surfaceNone },

  // single-mode tests
  '버그 고쳐줘': { mode: 'fix', chained_modes: null, ...surfaceBug },

  // session-scoping tests
  '사이드바 폭 파악해줘': { mode: 'explore', chained_modes: null, ...surfaceNone },
  '이거 더 자세히 분석해줘': { mode: 'fix', chained_modes: null, ...surfaceBug },
  'OAuth 부분 추가로 확인': { mode: 'fix', chained_modes: null, ...surfaceBug },
  '새 feature 만들자 — 결제 모듈': { mode: 'brainstorm', chained_modes: null, ...surfaceNone },
  '사이드바 분석': { mode: 'explore', chained_modes: null, ...surfaceNone },
  '로그인 분석': { mode: 'explore', chained_modes: null, ...surfaceNone },
  '이거 이어서': { mode: 'fix', chained_modes: null, ...surfaceBug },

  // surface-detection scenarios
  '텍스트 수정해줘': { mode: 'fix', chained_modes: null, ...surfaceText },
  'css 색깔 바꿔': { mode: 'fix', chained_modes: null, ...surfaceDesign },
  '오타 고쳐': { mode: 'fix', chained_modes: null, ...surfaceText },
  '이거 안 돌아가': { mode: 'fix', chained_modes: null, ...surfaceBug },
  'fix the login error': { mode: 'fix', chained_modes: null, ...surfaceBug },
  '파악해줘': { mode: 'explore', chained_modes: null, ...surfaceNone },
  '확인 좀 해줘': { mode: 'explore', chained_modes: null, ...surfaceNone },
  'analyze this function': { mode: 'explore', chained_modes: null, ...surfaceNone },
  '점검해': { mode: 'verify', chained_modes: null, ...surfaceNone },
  '테스트 해봐': { mode: 'verify', chained_modes: null, ...surfaceNone },
  'run the tests': { mode: 'verify', chained_modes: null, ...surfaceNone },
  '설계해줘': { mode: 'brainstorm', chained_modes: null, ...surfaceNone },
  '리팩토링할거야': { mode: 'brainstorm', chained_modes: null, ...surfaceNone },
  '새로운 기능 만들거야': { mode: 'brainstorm', chained_modes: null, ...surfaceNone },
  '다크모드 토글 추가해줘': { mode: 'implement', chained_modes: null, ...surfaceNone },
  '덧붙여서 이메일 알림도': { mode: 'implement', chained_modes: null, ...surfaceExt },
  'extend the auth flow': { mode: 'implement', chained_modes: null, ...surfaceExt },
});

export function classifyMode(prompt) {
  const text = String(prompt || '').trim();
  const hit = LOOKUP[text];
  if (hit) {
    return {
      schema_version: 2,
      mode: hit.mode,
      chained_modes: hit.chained_modes,
      trigger: `stub:${hit.mode}`,
      passthrough: false,
      target_type: hit.target_type,
      exempt: hit.exempt,
      skip_brainstorm: hit.skip_brainstorm,
    };
  }
  return {
    schema_version: 2,
    mode: 'fix',
    chained_modes: null,
    trigger: 'stub:unmapped-default',
    passthrough: false,
    target_type: null,
    exempt: null,
    skip_brainstorm: false,
  };
}
