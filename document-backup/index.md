---
title: smelter — Claude Code Agent CLI
type: index
tags: [smelter, harness, omc, cli, agent]
created: 2026-04-11
updated: 2026-04-13
---


# ⚙️ smelter

> **Claude Code 기반 Agent CLI 설정 도구.** `/Users/yusang/smelter/`

> 📌 **원칙: 위키 = 유일한 진실의 원천 (Source of Truth)**
> 이 문서가 smelter의 스킬·에이전트·모드·파일 구성에 대한 **최종 기준**이다.
> 위키에서 제거/수정된 항목은 항상 코드베이스에서도 물리적으로 변경해야 하며, 코드에만 존재하고 위키에 없는 항목은 완료되지 않은 것으로 간주한다. 아래의 페이지들도 반드시 함께 수정되어야한다.

## 구현
[[implementation]] - 전체 구현에 대한 상태 및 흐름

## 사용자 관점의 워크플로우
[[workflow]] - 이해를 위해 정리. 해둔 문서

## 철학
[[Introduce]] - 하네스의 원칙 및 지향을 담음



---

## 🎯 소개 — smelter란 무엇인가

> **"인간 개발자의 워크플로우를 그대로 자동화한다."**

smelter는 단순한 Claude Code 설정이 아니다. PM에게 업무를 받고, 조사하고, 설계하고, TDD로 개발하고, 검증하고, 리뷰하고, 배포하는 **실제 팀 개발 프로세스를 AI로 자동화하는 워크플로우 엔진**이다.

---

## 현재 구조

| 항목       | 현재 기준                                           |
| -------- | ----------------------------------------------- |
| 형태       | Claude Code 설정 레이어 (hooks + scripts + commands) |
| 설정 방식    | 파일 기반 작업 추적                                     |
| 모델 라우팅   | 에이전트 테이블로 명시적 모델 선택 (haiku/sonnet/opus)         |
| 검증 방식    | TDD 우선 + selected task의 change surface 기반 검증    |
| 작업 계획 상태 | `.smelter/` (plan/tasks/prd/sessions/wiki)      |
| 학습 시스템   | continuous-learning-v2 사용                       |
| 사용자 진입점  | magic keyword 혹은 직접 커맨드 입력으로 각 모드에 진입한다         |


---

