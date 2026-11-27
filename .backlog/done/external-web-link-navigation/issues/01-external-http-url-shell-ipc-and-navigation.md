# 01 — 공유 HTTP(S) URL 검증·shell IPC 및 전 에디터 모드 외부 웹 링크 이동

**Spec:** [spec.md](../spec.md)

**What to build:** 공유 `http`/`https` URL 검증 유틸과 **메인 창**·**보조 창** 공통 `shell` 외부 URL 열기 IPC를 구현하고(기존 **터미널 패널** 외부 URL 검증도 공유 유틸로 통합), 마크다운 링크 네비게이션 훅과 연결하여 **위지윅**·**Preview**·**Split**(일반 클릭 및 `Ctrl+클릭`)과 **Raw**(`Ctrl+클릭`)에서 유효한 `http://`·`https://` 웹 링크를 확인 창 없이 OS 기본 브라우저로 즉시 열며, 잘못된 `http(s)` URL이나 실행 실패 시 상단 **오류 배너**를 표시하고 `mailto:`는 무동작으로 유지합니다.

**Blocked by:** None — can start immediately

**Status:** resolved

- [x] 공유 URL 보안 유틸이 제어 문자, 비허용 스킴(`mailto:`, `javascript:`, `file:` 등), 호스트가 없는 잘못된 URL(`https://` 등)을 거부하고 유효한 `http://`·`https://` URL만 정규화해 허용하며, **터미널 패널** 외부 URL IPC가 이 공유 유틸을 재사용한다.
- [x] **메인 창**과 **보조 창** 모두에서 호출 가능한 `shell` 외부 URL 열기 IPC 및 Preload 브리지(`wikiApi.shell.openExternalUrl`)가 등록되며, 메인 프로세스 핸들러가 공유 유틸로 재검증한 유효 `http`/`https` URL에 대해서만 `shell.openExternal()`을 호출하고 비허용/오류 URL은 `false`를 반환한다.
- [x] 마크다운 링크 대상 해석기가 유효한 `http`/`https` URL(해시 프래그먼트 포함 웹 URL 포함)을 `{ kind: 'external', url }`로, 잘못된 `http:`/`https:` URL을 `{ kind: 'error', message }`로, `mailto:`를 `{ kind: 'noop' }`으로 분류하며 기존 `#슬러그` 및 상대 경로 `.md`/`.markdown` 해석과 **문서 목차** 동작을 깨뜨리지 않는다.
- [x] **위지윅**·**Preview**·**Split**(일반 클릭 및 `Ctrl/Cmd+클릭`)과 **Raw**(`Ctrl/Cmd+클릭`) 모드에서 `http`/`https` 웹 링크를 실행하면 확인 다이얼로그 없이 `openExternalUrl`이 호출되고, **보조 창**에서도 동일하게 동작한다.
- [x] 잘못된 `http(s)` URL 클릭, `openExternalUrl` 실패(`false` 반환 또는 reject), 또는 브리지 미지원 시 상단 **오류 배너**(`role="alert"`)가 표시되며, `mailto:` 클릭 시에는 오류 배너 없이 무동작을 유지한다.
- [x] 공유 URL 보안·링크 해석·IPC/Preload 경계 단위 테스트와 `<App />` 통합 테스트(**메인 창**·**보조 창**, 전 모드 웹 링크 이동 및 오류 배너 검증)가 모두 통과하며, `npm run typecheck`, `npm test`, `npm run build`가 통과한다.
