---
title: Harness Framework Optional Backlog
type: topic
tags: [ai-tools, claude-code, codex, harness, framework, optional, backlog, smelter]
created: 2026-04-09
updated: 2026-04-13
---

# Harness Framework Optional Backlog

> ← [[wiki/smelter/index|Harness Index]]

> 프레임워크별로 선택 적용하는 hooks, agents, rules, skills backlog.

---

## 1. 🪝 Hooks

### 프레임워크별 옵셔널

| 상태 | 훅 이름 | 대상 | 내용 |
|------|--------|------|------|
| 🔲 | `nextjs-build-check` | Next.js | `.ts/.tsx` 수정 후 `tsc --noEmit` 자동 실행 |
| 🔲 | `expo-typecheck` | Expo/RN | `app/` 하위 파일 수정 후 타입 체크 |
| 🔲 | `graphql-codegen-remind` | GraphQL | `.gql.ts` 수정 후 "codegen 실행했나요?" 리마인더 |
| 🔲 | `pnpm-build-packages` | pnpm monorepo | 패키지 파일 수정 후 `pnpm build:packages` 실행 |
| 🔲 | `kotlin-ktlint` | Kotlin/Android | `.kt` 수정 후 ktlint 자동 포맷 |

---

## 2. 🤖 Sub-agents

### 프레임워크별 옵셔널

> 별도 에이전트보다는 skill 분리 대상 후보로 본다.

| 상태   | 에이전트                    | 파일명                        | 핵심 역할                                                         |
| ---- | ----------------------- | -------------------------- | ------------------------------------------------------------- |
| 구현제외 | `nextjs-reviewer`       | `nextjs-reviewer.md`       | App Router/Pages Router 패턴, RSC vs RCC, Suspense 경계, 캐싱 전략 리뷰 |
| -    | `expo-reviewer`         | `expo-reviewer.md`         | Expo Router, NativeWind, Reanimated, EAS Build 패턴 리뷰          |
| -    | `graphql-reviewer`      | `graphql-reviewer.md`      | Schema 설계, N+1 쿼리, DataLoader, resolver 패턴 리뷰                 |
| -    | `supabase-reviewer`     | `supabase-reviewer.md`     | RLS 정책, Edge Functions, 마이그레이션 안전성 리뷰                         |
| -    | `nestjs-reviewer`       | `nestjs-reviewer.md`       | DI 패턴, Guard/Interceptor, DTO 검증, Lambda 배포 최적화 리뷰            |
| -    | `react-native-reviewer` | `react-native-reviewer.md` | 성능(FlatList, memo, useCallback), 플랫폼 분기, 접근성 리뷰               |

---

## 3. 📏 Rules

### 프레임워크별 옵셔널

| 상태 | 파일 | 핵심 내용 |
|------|------|---------|
| 🔲 | `rules/react/coding-style.md` | 컴포넌트 구조, hooks 규칙, `"use client"` 명시 기준 |
| 🔲 | `rules/react/testing.md` | React Testing Library 패턴, MSW 모킹 전략 |
| 🔲 | `rules/nextjs/coding-style.md` | App Router vs Pages Router 결정 기준, fetch revalidate 필수, path alias `@/` 사용 |
| 🔲 | `rules/nextjs/performance.md` | RSC 기본 원칙, Suspense 경계, Image/Font 최적화 |
| 🔲 | `rules/expo/coding-style.md` | `.web.ts`/`.native.ts` 분기 패턴, NativeWind, Solito 네비게이션 |
| 🔲 | `rules/graphql/coding-style.md` | 스키마 우선 설계, 쿼리/뮤테이션 파일 위치, codegen 실행 규칙 |

---

## 4. 📚 Skills

### 프레임워크별 옵셔널

| 상태 | 스킬 | 트리거 | 대상 |
|------|------|--------|------|
| 🔲 | `graphql-add-feature` | `/gql-feature` | GraphQL | Schema → Resolver → DTO → 타입 생성 → 테스트 워크플로우 |
| 🔲 | `db-migrate` | `/db-migrate` | Supabase | 마이그레이션 생성 → RLS 리뷰 → 적용 |
| 🔲 | `expo-screen` | `/expo-screen` | Expo | 새 스크린 스캐폴딩 → 라우팅 → 공유 컴포넌트 분리 |

---

## 🗓️ 실행 순서 (권장 로드맵)

```
Phase 1 — 프레임워크별 규칙
  🔲 rules/react/coding-style.md
  🔲 rules/react/testing.md
  🔲 rules/nextjs/coding-style.md
  🔲 rules/nextjs/performance.md
  🔲 rules/expo/coding-style.md
  🔲 rules/graphql/coding-style.md

Phase 2 — 프레임워크별 스킬
  🔲 graphql-add-feature
  🔲 db-migrate
  🔲 expo-screen

Phase 3 — 프레임워크별 훅
  🔲 nextjs-build-check
  🔲 expo-typecheck
  🔲 graphql-codegen-remind
  🔲 pnpm-build-packages
  🔲 kotlin-ktlint

Phase 4 — 별도 skill 후보로 분리한 리뷰어들
  구현제외 nextjs-reviewer
  구현제외 expo-reviewer
  구현제외 graphql-reviewer
  구현제외 supabase-reviewer
  구현제외 nestjs-reviewer
  구현제외 react-native-reviewer
```

---

## 관련 페이지

- [[wiki/external-harness-analysis/claude-codex-harness-structure]]
