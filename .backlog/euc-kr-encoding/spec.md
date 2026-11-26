# Spec: EUC-KR 인코딩 지원 (EUC-KR Text Encoding Support)

## Problem Statement (문제 정의)

현재 `wiki-editor`는 워크스페이스 파일 읽기·쓰기, **검색 패널** 본문·프론트매터 색인, 그리고 **Diff 뷰어**의 패치 디코딩을 모두 `UTF-8` 전용으로 처리합니다. 이로 인해 Windows 환경에서 작성된 기존 EUC-KR / CP949 마크다운 및 텍스트 문서를 열면 한글이 깨져 보이고(``), 편집 후 저장하면 원본 인코딩이 `UTF-8`로 덮어씌워지는 문제가 발생합니다. 또한 사용자가 문서 인코딩을 확인하거나 의도적으로 변환·다시 열기(Reopen)할 수 있는 수단이 없어 레거시 한국어 문서와 최신 UTF-8 문서를 함께 다루기 어렵습니다.

## Solution (해결 방안)

`UTF-8`과 `EUC-KR`(Windows 호환성을 위해 내부적으로 CP949 확장 완성형 코덱 사용, UI 표기는 `EUC-KR`) 두 가지 텍스트 인코딩을 지원합니다.

1. **자동 감지 및 인코딩 보존**: 텍스트 파일 열기, **검색 패널** 색인, **Diff 뷰어** 패치 디코딩 시 엄격한 UTF-8 유효성 검증을 우선 수행하고, 유효하지 않은 UTF-8 바이트 시퀀스가 존재하면 자동으로 `EUC-KR`(CP949)로 디코딩합니다. 열린 문서의 인코딩은 **문서 버퍼**에 기록되어 저장 시 동일 인코딩으로 유지됩니다.
2. **에디터 헤더 인코딩 전환 UI**: **에디터 헤더** 우측에 현재 문서 인코딩(`UTF-8` / `EUC-KR`) 버튼을 표시하고, 클릭 시 VS Code 방식의 메뉴를 통해 **인코딩으로 다시 열기(Reopen)**와 **인코딩 변경(변환)**을 구분해 제공합니다.
3. **데이터 손실 방지**: `EUC-KR`로 저장할 때 CP949로 표현할 수 없는 문자(이모지, 일부 특수 유니코드 등)가 포함된 경우 사전 감지하여, 수동 저장에서는 **확인 다이얼로그**로 `?` 대체 저장 또는 취소를 선택하게 하고, 자동 저장에서는 무음 손실을 막기 위해 저장을 보류하고 **오류 배너**로 안내합니다.

## User Stories (사용자 스토리)

1. As a Windows 위키 사용자, I want EUC-KR로 저장된 마크다운·텍스트 파일을 열 때 자동으로 EUC-KR로 인식되어 깨짐 없이 표시되고 저장 시에도 EUC-KR이 유지되길, so that 레거시 문서를 별도 변환 없이 그대로 읽고 편집할 수 있다.
2. As a 문서 작성자, I want **에디터 헤더**에서 현재 열려 있는 문서의 인코딩(`UTF-8` 또는 `EUC-KR`)을 한눈에 확인하길, so that 지금 보고 있는 문서가 어떤 인코딩 상태인지 즉시 파악할 수 있다.
3. As a 문서 작성자, I want **에디터 헤더** 메뉴의 **인코딩으로 다시 열기(Reopen)**를 통해 디스크의 원본 바이트를 원하는 인코딩(`UTF-8` 또는 `EUC-KR`)으로 다시 디코딩하길, so that 자동 감지와 다른 인코딩으로 잘못 해석된 파일도 올바르게 다시 읽을 수 있다(미저장 변경 사항이 있으면 **확인 다이얼로그**로 경고 후 진행).
4. As a 문서 작성자, I want **에디터 헤더** 메뉴의 **인코딩 변경(변환)**을 선택했을 때 현재 편집 중인 텍스트를 유지한 채 대상 인코딩만 변경되고 미저장(`●`) 상태로 표시되길, so that `Ctrl+S` 또는 자동 저장 시점에 새 인코딩으로 저장하고, 저장 전 원래 인코딩으로 되돌리면(본문 변경이 없을 때) 미저장 상태가 자동으로 해제되도록 할 수 있다.
5. As a 문서 작성자, I want `EUC-KR`로 수동 저장(`Ctrl+S` 또는 저장 버튼)할 때 EUC-KR로 표현할 수 없는 문자(이모지 등)가 있으면 **확인 다이얼로그**에서 손실될 문자 예시를 확인한 뒤 `?` 대체 저장 진행 또는 취소를 선택하길, so that 의도치 않게 글자가 `?`로 손실되는 사고를 막을 수 있다.
6. As a 자동 저장을 켜둔 사용자, I want `EUC-KR` 문서에 표현 불가 문자가 포함되어 있을 때 자동 저장이 무음으로 `?` 덮어쓰기를 하지 않고 저장을 보류하며 **오류 배너**로 안내하길, so that 편집 중 본문이 조용히 손상되는 일을 방지할 수 있다.
7. As a 설정 및 스키마 관리자, I want 전역 `config.json` 및 `.wiki-editor/frontmatter.json`이 항상 `UTF-8`로 고정되고 이미지 미리보기 탭에서는 인코딩 전환 UI가 숨겨지길, so that JSON 설정·스키마 규격과 바이너리 이미지가 인코딩 변환으로 손상되지 않는다.
8. As a 멀티 창·분할 편집 사용자, I want 같은 문서를 **메인 창**, **보조 창**, 분할된 **편집기 영역**에 동시에 열어 두었을 때 인코딩 변경·다시 열기·미저장 상태가 모든 창에 실시간 동기화되길, so that 어느 창에서 작업하더라도 일관된 인코딩 상태를 유지할 수 있다.
9. As a 위키 탐색자, I want **검색 패널**에서 본문 검색이나 **프론트매터 필터 바** 속성 조회를 수행할 때 EUC-KR로 저장된 워크스페이스 문서도 누락 없이 검색되길, so that 인코딩이 혼재된 워크스페이스에서도 전체 문서를 통합 검색할 수 있다.
10. As a 버전 관리 사용자, I want **Diff 뷰어**(`Changes`, `Stashes`, `Graph`, `Compare` 모든 Diff 모드 및 미추적 새 파일 포함)에서 EUC-KR 파일 변경분과 UTF-8 ↔ EUC-KR 인코딩 전환 커밋의 변경 내용이 한글 깨짐 없이 표시되길, so that Git 이력과 변경 사항을 정확히 검토할 수 있다.

## Implementation Decisions (구현 결정사항)

### 1. 지원 인코딩 및 패키징 제약
- 지원 인코딩 타입은 `TextEncoding = 'utf-8' | 'euc-kr'`로 정의하고, UI 표기는 `'UTF-8'` 및 `'EUC-KR'`을 사용합니다.
- `'euc-kr'`의 실제 디코딩/인코딩 코덱은 Windows 호환성을 위해 확장 완성형인 **CP949**(`iconv-lite`)를 사용합니다.
- Electron 패키징 테스트(`dependencies`는 `node-pty` 단독 유지)를 준수하기 위해 `iconv-lite`는 `devDependencies`에 추가하고 번들러가 메인 프로세스 번들(`out/**/*`)에 인라인 번들링하도록 구성합니다.

### 2. 자동 감지 및 손실 검사 규칙
- **자동 감지(Auto-detect)**:
  - 바이너리 판별(선두 8KB 널 바이트 검사 등) 통과 후, 먼저 엄격한 UTF-8 디코딩(`TextDecoder('utf-8', { fatal: true })`)을 시도합니다.
  - 유효한 UTF-8 바이트 시퀀스(순수 ASCII 및 빈 파일 포함)이면 `'utf-8'`로 판정합니다.
  - 유효하지 않은 UTF-8 시퀀스가 발견되면 CP949로 디코딩하고 `'euc-kr'`로 판정합니다.
- **표현 불가 문자(Unencodable Characters) 감지**:
  - `'euc-kr'` 저장 전, 입력 문자열을 CP949로 인코딩하고 다시 디코딩하여 원본 문자와 일치하지 않는 문자(원래 리터럴 `'?'` 문자는 정상 처리하고, CP949 매핑 불가로 `'?'` 등으로 치환된 문자만 추출)를 검출합니다.
  - 검출 시 `{ count: number, samples: string[] }` 구조화 정보를 생성하며, 명시적 `allowLossy: true` 플래그가 없는 쓰기 요청은 디스크를 변경하지 않고 구조화된 손실 오류를 반환합니다.

### 3. 문서 버퍼(Document Buffer) 모델 및 상태 불변식
- **문서 버퍼** 데이터 모델에 `encoding: TextEncoding`과 `savedEncoding: TextEncoding`을 추가합니다(기본값 `'utf-8'`).
- **미저장 불변식(Dirty Invariant)**:
  - 텍스트 버퍼의 `isDirty`는 `content !== savedContent || encoding !== savedEncoding`으로 계산합니다.
  - 이미지 버퍼, `config.json` 버퍼, `.wiki-editor/frontmatter.json` 버퍼는 항상 `encoding: 'utf-8'`, `savedEncoding: 'utf-8'`로 고정하며 인코딩 변경/재열기 요청을 거부합니다.
- **허브 연산 계약**:
  - `openWorkspaceFile`: 디스크에서 자동 감지된 `{ content, encoding }`을 읽어 `encoding`과 `savedEncoding`을 초기화합니다(미존재 신규 파일인 경우 `'utf-8'`로 초기화).
  - `setEncoding(key, nextEncoding)`: 현재 메모리 `content`는 유지한 채 `encoding`을 `nextEncoding`으로 변경하고 `isDirty`를 재계산합니다. `isDirty`가 `true`가 되면 자동 저장 타이머를 스케줄링하고, 원래 `savedEncoding`으로 되돌려 `isDirty === false`가 되면 대기 중인 자동 저장 시도를 취소합니다.
  - `reopenWithEncoding(key, targetEncoding)`: 디스크 원본 바이트를 지정한 `targetEncoding`으로 강제 디코딩하여 `content`, `savedContent`, `encoding`, `savedEncoding`을 갱신하고 `isDirty = false`로 초기화합니다.
  - `saveBuffer(key, options?: { allowLossy?: boolean })`:
    - 현재 버퍼의 `encoding`과 `allowLossy`를 스토리지 계층에 전달합니다.
    - 수동 저장에서 표현 불가 문자가 검출되면 디스크를 수정하지 않고 구조화된 손실 정보(`unencodableChars`)를 포함한 실패 결과를 반환합니다(`save-error` 브로드캐스트 없이 호출자가 **확인 다이얼로그**로 처리 가능하도록 구분).
    - 자동 저장은 항상 `allowLossy: false`로 실행하며, 표현 불가 문자로 실패 시 해당 변경 상태에 대한 자동 저장 재시도를 중단하고 `save-error` 이벤트를 발행해 **오류 배너**에 안내합니다(이후 본문이나 인코딩이 바뀌면 재시도 가능).
  - **외부 변경 재조정(Reconciliation)**: 디스크에서 깨끗한(`!isDirty`) 파일이 외부 수정되었을 때 내용과 함께 인코딩도 다시 감지해 `content`, `savedContent`, `encoding`, `savedEncoding`을 동기화합니다.

### 4. 워크스페이스 검색 및 Git Diff 연동
- **검색 패널 & 프론트매터 조회**: 워크스페이스 텍스트 파일 검색 시 2MB 크기 제한 및 선두 8KB 널 바이트 바이너리 검사 이후, 동일한 엄격 UTF-8 → CP949 자동 감지 디코더로 텍스트를 복원해 검색과 프론트매터 파싱을 수행합니다.
- **Diff 뷰어 (`GitService.diff`)**:
  - `unstaged`, `staged`, `commit`, `stash`, `branch-compare` 패치 출력은 **줄 단위(line-by-line)**로 엄격 UTF-8 검증을 수행해 유효한 줄은 UTF-8로, 유효하지 않은 줄은 CP949로 디코딩합니다. 이를 통해 순수 EUC-KR 파일 Diff뿐 아니라 한 커밋 내에서 `UTF-8` ↔ `EUC-KR`로 인코딩이 전환된 Diff도 양쪽 줄 모두 깨지지 않고 표시됩니다.
  - 미추적(untracked) 새 파일 본문은 전체 버퍼 기준 자동 감지(UTF-8 → CP949)로 디코딩합니다.
  - `GIT_DIFF_MAX_BYTES` 절단은 멀티바이트(UTF-8/CP949) 문자 경계가 깨지지 않도록 안전하게 절단하고, 기존 바이너리 파일 판별(`hasNullByte` / `Binary files ... differ`)은 그대로 유지합니다.

## Testing Decisions (테스트 결정사항)

- **검증 기준**: 내부 구현 세부가 아니라 공개 인터페이스와 사용자 관점의 외부 관찰 동작(바이트 입출력, 버퍼 상태 전이, IPC 동기화, Diff 출력, UI 상호작용 및 다이얼로그)을 검증합니다.
- **사전 합의된 테스트 심 (Pre-agreed Testing Seams)**:
  1. **텍스트 인코딩 코덱·감지 API**: Catches 엄격 UTF-8 검증 및 CP949 폴백 오판, 멀티바이트 경계 절단 깨짐, EUC-KR 표현 불가 문자 감지 누락 및 `?` 대체 인코딩 오류 / Misses 파일시스템 보안, IPC 직렬화, UI 상태
  2. **워크스페이스 FS·검색 서비스 (`WorkspaceFsService` + `WorkspaceQueryAndSchemaHub`)**: Catches 디스크 바이트 읽기/쓰기 인코딩 보존, 명시 인코딩 재열기, 손실 보호 거부/허용, **검색 패널**·프론트매터 조회의 EUC-KR 디코딩 및 바이너리 제외 / Misses 다중 창 버퍼 동기화, 렌더러 UI
  3. **공유 문서 버퍼 허브 (`SharedDocumentBufferHub` + IPC 등록 계층)**: Catches `encoding`/`savedEncoding` 기반 `isDirty` 판정·원복, `Reopen` 재디코딩, 수동 저장 손실 오류/`allowLossy` 강제 저장, 자동 저장 보류·`save-error`, 외부 변경 재조정, 멀티 윈도우 동기화 / Misses 실제 DOM 메뉴·확인 다이얼로그 상호작용
  4. **Git Diff 서비스 (`GitService.diff`)**: Catches `unstaged`/`staged`/`commit`/`stash`/`branch-compare` 및 미추적 파일의 EUC-KR·혼합 인코딩 패치 디코딩, 최대 바이트 절단 안전성, 바이너리 판별 / Misses Diff 뷰어 UI 렌더링
  5. **렌더러 앱 통합 심 (`App` + `InMemoryWikiHarness`)**: Catches **에디터 헤더** 인코딩 메뉴(`다시 열기`/`인코딩 변경`), 미저장 재열기·손실 저장 **확인 다이얼로그**, 자동 저장 보류 **오류 배너**, JSON/이미지 탭 보호, 메인·보조 창 동기화 / Misses 실제 OS 디스크 I/O 및 패키징 제약(`packaging.test.ts`로 보완)
- **참고할 기존 테스트 패턴(Prior art)**:
  - 격리된 임시 디렉토리 기반 서비스 테스트(Workspace FS, Git 저장소 샌드박스)
  - 인메모리 멀티 윈도우 하니스 기반 렌더러 통합 테스트(`App.editor.test.tsx`, `App.multiWindow.bufferSync.test.tsx`)
  - 패키징 매니페스트 검증 테스트(`packaging.test.ts`)

## Out of Scope (범위 제외 사항)

- `UTF-8 with BOM`, `UTF-16`, `Shift-JIS` 등 `UTF-8` / `EUC-KR` 외의 추가 인코딩 지원
- 전역 설정 패널이나 워크스페이스 단위 기본 인코딩(Default Encoding) 설정 UI
- 폴더 트리에서의 다중 파일 일괄 인코딩 변환 기능
- 엄격한 순수 KS X 1001(CP949 확장 문자 차단) 모드 분리

## Further Notes (기타 참고사항)

- 프로젝트 규칙에 따라 사용자용 기능 추가 시 `docs/manual.md`와 도메인 용어집 `CONTEXT.md`를 함께 갱신해야 합니다.
- `WorkspaceFsService`의 모든 파일 접근은 기존 경로 보안(`pathSecurity`) 및 원자적/안전 쓰기 규칙을 그대로 준수합니다.
