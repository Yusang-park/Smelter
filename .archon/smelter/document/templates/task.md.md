### `features/{slug}/task/{task-name}.md`

```markdown
---
title: {제목}
status: pending | in_progress | blocked | done
type: issue | feature | need-review
created: YYYY-MM-DD
---

각 체크 박스는 3가지로 구분된다.
✅: 통과
⚠️: 오류 : 오류 처리된것을 우선적으로 queue에 올려 해결한다
빈칸: 수행전

# {제목}

## Background
{문제 배경}

## Approaches
- [ ] 접근 방식 A: ...
- [ ] 접근 방식 B: ...
채택: {선택한 방식 + 이유}

## Queue
- [ ] 기능 1 구현
  - [ ] 1-1: ...
- [ ] TDD 작성 (최소 10개)
- [ ] E2E 작성

## Verify
- [ ] 1단계
- [ ] 2단계
- [ ] 3단계

## Wiki Links
- 

## Risks
(Step 6, 9, 10에서 채워짐)

## Results
- 비디오: 
- 로그: 
- 브랜치: 
```
