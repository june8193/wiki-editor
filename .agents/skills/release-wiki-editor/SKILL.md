---
name: release-wiki-editor
description: wiki-editor 프로젝트 릴리즈(버전 추천, CHANGELOG 작성, 타입체크·테스트·빌드 검증 및 배포 커밋/푸시). Use when releasing wiki-editor.
---

# wiki-editor 릴리즈 관리 (release-wiki-editor)

직전 릴리즈 이후 `master` 브랜치의 변경 내역을 분석해 버전을 산출하고, 사용자 승인 후 검증·커밋·푸시까지 완료하는 6단계 절차입니다.

---

### 1단계: Pre-flight 점검
1. `git branch --show-current`가 `master`인지 확인합니다. 다른 브랜치면 중단하고 브랜치 전환을 요청합니다.
2. `git status --porcelain` 출력이 비어 있는지 확인합니다. 미커밋·미추적 파일이 있으면 중단하고 정리를 요청합니다.

### 2단계: Diff Audit
1. `package.json`에서 현재 `"version"`을 확인합니다.
2. 직전 릴리즈 커밋을 조회합니다:
   ```powershell
   git log --grep="release:" -n 1 --format="%H %s"
   ```
3. 직전 릴리즈 이후(`LAST_RELEASE_HASH..HEAD`, 직전 릴리즈가 없으면 전체 히스토리) 모든 커밋과 머지 내역을 수집합니다:
   ```powershell
   git log <RANGE> --oneline
   git log <RANGE> --merges --oneline
   ```
4. 이번 릴리즈에 포함된 `.backlog/done/<feature-slug>/spec.md` 및 `issues/*.md`를 매핑합니다.

### 3단계: Approval Gate (Read-Only)
> [!IMPORTANT]
> **사용자의 명시적 승인을 받기 전까지 모든 파일과 Git 상태는 읽기 전용으로 유지합니다.**

1. 아래 항목을 정리해 사용자에게 보고합니다:
   - 현재 버전 및 [SemVer](https://semver.org/lang/ko/) 기준 추천 버전 (Major/Minor/Patch 판정 근거)
   - 주요 변경 내역 요약 (머지된 기능 및 백로그 링크)
   - `CHANGELOG.md` 반영 예정 초안 전문
2. 승인을 요청한 뒤 턴을 종료하고 사용자 응답을 기다립니다.

### 4단계: Changelog & Version Bump
1. `CHANGELOG.md`의 구분선(`---`) 바로 아래에 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/) 양식으로 신규 섹션을 추가합니다:
   ```markdown
   ## [X.Y.Z] - YYYY-MM-DD
   ### Added
   - 추가 기능 요약 ([상세 스펙](.backlog/done/<feature-slug>/spec.md))
   ### Changed
   - 변경 사항 요약
   ### Fixed
   - 버그 수정 요약
   ```
2. 승인된 버전으로 `package.json`과 `package-lock.json`을 갱신합니다:
   ```powershell
   npm version X.Y.Z --no-git-tag-version
   ```

### 5단계: Verification
아래 세 검증이 모두 0 failures로 통과할 때까지 실행합니다. 하나라도 실패하면 중단하고 실패 로그를 보고합니다:
```powershell
npm run typecheck
npm test
npm run build
```

### 6단계: Ship
1. 변경된 릴리즈 파일을 스테이징하고 커밋합니다:
   ```powershell
   git add package.json package-lock.json CHANGELOG.md
   git commit -m "release: vX.Y.Z"
   ```
2. 원격 저장소에 푸시합니다:
   ```powershell
   git push origin master
   ```
3. 배포 버전, 커밋 해시, 릴리즈 요약을 최종 안내합니다.
