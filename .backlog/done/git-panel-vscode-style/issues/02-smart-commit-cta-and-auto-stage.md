# 02 — 스마트 커밋 CTA (`Commit ▾` / `Publish Branch` / `Sync Changes`) 및 자동 Stage 확인 흐름

**Spec:** [spec.md](../spec.md)

**What to build:** **Changes 섹션**의 커밋 메시지 입력창을 1줄 자동 높이 조절 입력창(`메시지 (Ctrl+Enter로 "<branch>"에 커밋)`)으로 개편하고, 저장소 상태에 따라 전환되는 VS Code 스마트 기본 CTA 버튼(`✓ Commit | ▾` 스플릿 드롭다운: `Commit` / `Commit & Push` / `Commit & Sync`, 클린 시 `☁ Publish Branch` / `↻ Sync Changes N↓ M↑`)과 `Staged = 0` 상태에서 커밋 실행 시 **확인 다이얼로그**를 거쳐 전체 자동 Stage 후 커밋하는 흐름을 엔드투엔드로 구현합니다.

**Blocked by:** 01-git-fetch-and-header-branch-subrow

**Status:** resolved

- [x] 순수 스마트 CTA 상태 판정 모듈이 변경 있음(`commit`), 클린+미게시(`publish`, unborn/detached 제외), 클린+미동기화(`sync`), 클린+동기화 완료/병합 충돌(`commit` 비활성) 및 `requiresAutoStageConfirm` 전이를 정확히 계산하고 단위 테스트로 검증됩니다.
- [x] 커밋 입력창이 1줄 기본 높이에서 입력량에 따라 자동 확장되며, 현재 브랜치명이 포함된 한국어 placeholder(`메시지 (Ctrl+Enter로 "<branch>"에 커밋)`)와 `Ctrl+Enter`/`Cmd+Enter` 단축키를 지원합니다.
- [x] 변경 사항이 있을 때 `✓ Commit | ▾` 스플릿 버튼이 렌더링되며, `▾` 드롭다운에서 `Commit`, `Commit & Push`, `Commit & Sync`를 실행할 수 있고 외부 클릭 또는 `Escape` 키로 닫힙니다.
- [x] `Staged = 0`이고 Unstaged/Untracked 변경이 있을 때 `Commit` / `Commit & Push` / `Commit & Sync` 또는 `Ctrl+Enter`를 실행하면 빈 메시지 인라인 검증을 먼저 수행한 뒤 **확인 다이얼로그**로 전체 자동 Stage 여부를 확인하며, 승인 시 단일 작업 잠금 하에 `stageAll` → `commit`(및 선택한 `push`/`sync`)이 순차 실행되고 취소 시 아무 변경도 일어나지 않습니다.
- [x] 복합 실행(`Commit & Push` / `Commit & Sync`)에서 커밋은 성공했으나 후속 원격 작업이 실패·취소된 경우 커밋 입력 메시지는 비워지고 원격 실패만 오류 배너에 표시되며, `Commit & Sync`는 기존 미저장 **문서 버퍼** 보호 확인을 준수합니다.
- [x] 병합 충돌(`hasConflicts`) 존재 시 스마트 CTA와 드롭다운이 모두 비활성화되고 기존 충돌 안내가 유지되며, 클린 상태에서 `Publish Branch` / `Sync Changes` 클릭 시 각각 Push/Sync가 실행됩니다.
- [x] `<App />` 통합 테스트 및 단위 테스트로 모든 상태 전이를 검증하고, `npm run typecheck`, `npm test`, `npm run build`가 모두 통과합니다.
