# Kế hoạch và trạng thái triển khai plugin-startup-guardian

Trạng thái cập nhật: 2026-11-07. Candidate plugin có single-node mode, opt-in app-only HA slice và source-level Docker Compose overlay; chưa xác minh image hay triển khai production.

## Trạng thái nghiệm thu hiện tại

- **P0: GO có điều kiện cho baseline single-node đã test.** Test child-process dùng core app/test runtime, PostgreSQL 16, schema/prefix `applicationPlugins` thật, Guardian IPC/journal, fresh process, retry, và cả API `pm:listEnabled`/`pm:listEnabledV2`. Tự phục hồi chỉ được mở cho `@nocobase/server` đúng `2.2.40` và `DB_DIALECT=postgres`; không suy rộng ra core/dialect khác. HA có process proof riêng bên dưới, không mở rộng baseline này.
- **P1: source và test đã triển khai.** Default observe-only, lifecycle wrapper, versioned journal/policy, CLI, UI v1/v2, locale và local lock có source. Bootstrap contract được smoke-test bằng stub; production image chưa xác minh.
- **P2: một phần, không nghiệm thu đầy đủ.** Có runner single-node, direct mandatory-dependent refusal, CAS retry với token `updatedAt::text` chính xác, attempt counter tồn tại qua restart và local process lock. Chưa có full fault-boundary matrix hoặc transitive dependency closure.
- **P3: một phần.** Server endpoints/ACL được test qua HTTP thực; shared HA status/inspect/approve/auto dùng revision CAS. Client v1/v2 source/locales tồn tại; browser interaction, a11y và complete UI flow chưa được kiểm chứng.
- **P4: một phần có kiểm soát.** Có explicit app-only enrollment, Cluster Manager Redis recovery lock, PostgreSQL fencing/control protocol, cohort drain/readiness gate, shared CLI/API, isolated two-runner/two-app proof, và default-off Docker HA overlay. Overlay shell/Compose checks dùng stubs; HA retry, workers/sandboxes, Kubernetes, production proxy, rolling version changes và production image validation chưa được test.
- **P5: local artifact checks hoàn tất.** Windows `--no-dts` builds, tarball contents và extracted CLI/API import smoke pass. CI tag/release/npm publication is a separate post-push gate; no live deployment is claimed. Chi tiết trong `VALIDATION.md`.
- **P6: deferred.** Chưa có early static-import interception; không sửa core/upstream.

### P0 go/no-go

P0 prototype chứng minh single-node process recovery trên PostgreSQL 16 và NocoBase `2.2.40`. Phần HA bổ sung là opt-in, app-only và chỉ được kiểm chứng bằng hai app processes, PostgreSQL 16 cùng Redis 8 dùng riêng cho test. Chưa đủ bằng chứng cho production image, workers, Kubernetes, dialect/core version khác hoặc lỗi ngoài lifecycle/allowlist. Nếu version/dialect/API version không khớp, Guardian từ chối auto recovery.

Baseline khảo sát: NocoBase 2.2.40, fork `OrgGem/nocobase-beta`, branch `main`, commit `4c1fe95b5f`.

## 1. Mục tiêu và phạm vi

Khi một custom plugin gây lỗi lifecycle trong quá trình khởi động, hệ thống xác định plugin gây lỗi, ghi nhận quyết định cách ly, rồi khởi động process mới mà không load instance của plugin đó. App chỉ được đánh dấu sẵn sàng sau khi hoàn tất startup. Quản trị viên có thể xem nguyên nhân và yêu cầu thử lại có kiểm soát.

Triển khai tập trung, không sửa từng custom plugin và không sửa source core/upstream. Phạm vi file:

- `packages/plugins/plugin-startup-guardian/**`: plugin, bootstrap runner, test và tài liệu.
- `docker/production-ha/**`: tích hợp runner vào entrypoint và cấu hình triển khai.
- `k8s/production-ha/**`: tích hợp tương ứng sau khi single-node đạt nghiệm thu.

Không thay đổi deployment đang chạy, commit/push, tag hoặc publish trong giai đoạn lập kế hoạch. Khi triển khai, dùng workflow custom-plugin hiện có; chỉ cân nhắc sửa workflow nếu artifact mới thực sự cần và tuân thủ ngoại lệ đúng file đã được cho phép.

## 2. Cơ sở kỹ thuật đã xác nhận

| Vị trí source | Hành vi cần giữ trong thiết kế |
| --- | --- |
| `packages/core/app/src/index.ts` và `server/src/run-plugin-static-imports.ts` | Import package và chạy `staticImport()` trước khi load trạng thái enabled từ DB; plugin bị disable vẫn có thể được import. |
| `packages/core/server/src/application.ts`, `load()` | `pm.initPlugins()` chạy trước application event `beforeLoad`, sau đó mới `pm.load()`. |
| `packages/core/server/src/plugin-manager/plugin-manager.ts`, `load()` | Chạy toàn bộ `beforeLoad()` trước vòng `loadCollections/loadAI/load`; lỗi có thể làm reject cả lần load. |
| Cùng file, `add()` và `addOrThrow()` | `add()` log lỗi; `afterAdd()` thất bại có thể để lại instance đã đăng ký. |
| `packages/core/server/src/commands/pm.ts` | `pm disable` có preload, không phải đường cứu hộ độc lập với app startup. |
| `packages/core/server/src/plugin-manager/options/resource.ts` | Cả client v1 và v2 lấy danh sách plugin từ DB với `enabled: true`. |
| `docker/production-ha/scripts/app-runtime-entrypoint.sh` | Install/upgrade xảy ra trước start; không được coi lỗi migration là lỗi load có thể bỏ qua. |

Khảo sát trước kế hoạch có 8/8 probe pass: bốn lỗi lifecycle, lỗi afterAdd, guardian đăng ký cuối vẫn bọc được beforeLoad, lỗi afterStart, và disable CLI bị chặn bởi preload. Đây là bằng chứng hành vi core; chưa phải test của sản phẩm guardian hoặc bằng chứng phục hồi production.

## 3. Kiến trúc đề xuất

### 3.1. Guardian trong application

- Đăng ký từ `afterAdd()` một listener application `beforeLoad`, bọc phương thức gốc `beforeLoad`, `loadCollections`, `loadAI`, `load` của các instance thuộc phạm vi theo dõi.
- Giữ nguyên `this`, tham số, kết quả và thứ tự thực thi; rethrow lỗi sau khi ghi nhận, không tiếp tục startup trên app đã khởi tạo dở.
- Chống bọc lặp khi reload; state phải theo application/instance, không dùng biến global để gán plugin đang chạy cho mọi app.
- Không sao chép toàn bộ thuật toán `PluginManager.load()` và không thay thế core bằng implementation riêng.
- Application event trước listener guardian, constructor, afterAdd, import và listener startup không có owner rõ ràng chưa nằm trong cam kết tự cách ly của MVP.
- `staticImport()` chỉ là điểm mở rộng có thể khảo sát thêm, không được giả định chạy trước mọi plugin khác.

### 3.2. Runner trước application

- Chạy từ package guardian đã build, không phụ thuộc việc instance guardian được enable hoặc load thành công.
- Giữ vai trò supervisor trực tiếp cho process app; chọn một cấp điều phối restart, tránh vòng lặp runner → PM2 → Docker cùng retry độc lập. P0 phải chứng minh lệnh khởi chạy phù hợp với image hiện tại.
- Nhận journal startup từ child; phân biệt lỗi có owner rõ ràng, app command_error nhưng process còn sống, child exit, timeout và tín hiệu dừng có chủ đích.
- Khi có lỗi đủ điều kiện, dừng child và chờ nó kết thúc trước khi thay đổi trạng thái rồi tạo process mới. Truyền signal đúng và thu hồi process con; không để runner biến lỗi thành ready.
- Có chế độ chỉ quan sát và chế độ tự cách ly được bật rõ ràng. Mặc định lần triển khai đầu là chỉ quan sát.
- Có lệnh cứu hộ đọc trạng thái/áp dụng quyết định đã xác thực mà không gọi `app.load()` hoặc `pm disable`.

### 3.3. Dữ liệu và tính nhất quán

- `applicationPlugins.enabled` là trạng thái hiệu lực để server và client v1/v2 cùng loại plugin. Chỉ thay đổi row đã xác minh của đúng app/package; giữ `installed`, version và dữ liệu nghiệp vụ.
- Journal độc lập với lifecycle app lưu: schemaVersion, appId, campaignId, bootId, deployment identity, core/plugin version, package name, phase, timestamps, error fingerprint, trạng thái trước đó, quyết định và các dependent bị ảnh hưởng.
- MVP single-node: journal trên persistent storage, ghi atomic, giới hạn kích thước/retention, quyền truy cập tối thiểu; không lưu token, chuỗi kết nối hoặc toàn bộ payload nhạy cảm. Không tạo collection nghiệp vụ mới nếu không cần.
- Quy trình ghi: lưu durable intent → cập nhật DB có điều kiện/transaction → ghi applied. Recovery phải reconcile crash tại từng ranh giới; không giả định journal và DB cùng transaction.
- Bootstrap truy cập bảng plugin bằng adapter tối thiểu dùng cấu hình DB thực tế. Không import preset hoặc khởi tạo app chỉ để đọc DB; không chạy sync/migration tự động. P0 phải xác nhận dialect, prefix/schema, tenant/app identity và credentials trước khi chọn adapter.
- Nếu DB/schema chưa sẵn sàng, journal hỏng, quyền ghi thiếu hoặc identity không khớp: dừng tự cách ly, báo recovery-required; không đoán hoặc tự sửa schema.
- Phân biệt admin disable và guardian quarantine bằng journal; không tự bật lại row đã bị admin thay đổi sau quyết định cách ly. Retry dùng kiểm tra revision/state, không ghi đè mù.
- Plugin preset/bắt buộc có thể không tuân theo DB enabled; không đưa chúng vào allowlist tự cách ly MVP.

### 3.4. Trạng thái và retry

Luồng thành công: `starting → ready`.

Luồng lỗi xử lý được: `starting → attributed-failure → quarantine-pending → quarantined → fresh-start → ready`.

Luồng không đủ điều kiện: `starting → recovery-required`.

- Khởi đầu giới hạn một lần khởi động lại cho mỗi quyết định cách ly, tối đa hai quyết định trong một campaign; dependent closure tính trong cùng quyết định. Giới hạn phải được lưu bền để container restart không reset bộ đếm.
- Một campaign tồn tại xuyên qua restart; chỉ mở campaign mới bằng yêu cầu quản trị hoặc quy tắc deployment đã được xác minh. Không tự tạo lại campaign chỉ vì process đổi PID.
- Tự động restart không đồng nghĩa tự enable lại. Quarantine tồn tại sau khi nâng package cho tới khi có yêu cầu retry.
- Retry phục hồi một nhóm dependency đã xác nhận, có kế hoạch gián đoạn và audit. Nếu tiếp tục lỗi thì cách ly lại; không retry vô hạn.
- Khi hết ngân sách: giữ runner ở recovery-required, readiness false; không dùng exit-loop để tạo lại ngân sách. Recovery không phụ thuộc trang quản trị trong app đang hỏng.
- Rollback guardian không tự enable plugin đã cách ly; giữ manifest quyết định và hướng dẫn phục hồi thủ công có kiểm tra.

## 4. Chính sách quyết định cách ly

1. Có lỗi phát sinh trong lifecycle được bọc, với app/package/version/phase xác định.
2. Plugin nằm trong allowlist quản trị và không thuộc protected set: guardian, core, authentication, ACL, database hoặc dependency bắt buộc của chúng.
3. Không chỉ dựa vào tên plugin ở dòng log cuối. Lifecycle là nơi phát sinh lỗi chưa đủ chứng minh lỗi thuộc plugin: DB/Redis/network dùng chung, shutdown/cancel và lỗi hạ tầng không được tự quy thành lỗi plugin.
4. Chỉ tự xử lý các loại lỗi đã có quy tắc nhận diện và test; lỗi chưa phân loại chuyển recovery-required. Cách nhận diện phải được hoàn thiện ở P0, không dùng heuristic thông điệp lỗi làm bằng chứng duy nhất.
5. Xây dependency closure từ dependency runtime bắt buộc đã xác minh; xét `dependencies`, peer dependencies không optional và cấu hình dependency bổ sung. Không coi mọi peer dependency là bắt buộc. Với dependency không rõ, không tự cascade.
6. Nếu closure chạm plugin protected, dừng tự phục hồi. Phát hiện chu kỳ và xử lý closure như một đơn vị.
7. Migration/install/upgrade thất bại không tự disable để bỏ qua; giữ maintenance/recovery-required và thông tin chẩn đoán.
8. Process crash, OOM, process.exit, top-level import và timeout không rõ owner: chỉ ghi nhận, không tự disable plugin cuối cùng được log.

## 5. Work packages và điều kiện hoàn tất

### P0 — Prototype và quyết định khả thi

- [x] Chuyển probe lifecycle và CLI disable thành test có thể chạy lại; 8 probe core ban đầu vẫn nằm trong `core-lifecycle-probes.test.ts`.
- [x] Runner điều khiển child process; lỗi lifecycle thực tế được ghi nhận qua IPC, child dừng, DB đổi trong process sạch, và app mới báo ready.
- [x] Test dùng collection `applicationPlugins` của core, schema/prefix thật trong fixture PostgreSQL; CAS giữ nguyên metadata và so sánh timestamp chính xác.
- [x] `enabled=false` ngăn instance và v1/v2 API trả đúng array 200 không chứa plugin; retry thử lại bằng boot mới và xác nhận API chứa plugin.
- [x] Chế độ observe, exact fingerprint policy, protected set, DB/version gate và trực tiếp mandatory-dependent refusal được test.
- [ ] Multi-app/reload rộng và toàn bộ lỗi startup không có owner chưa được test.

Điều kiện qua P0: demo một plugin allowlisted lỗi trong load, runner ghi nhận đúng plugin, process cũ kết thúc, DB được cập nhật đúng và process mới phục vụ thành công. Nếu không đạt mà cần sửa core, ghi rõ blocker và điều chỉnh phạm vi; không âm thầm sửa core.

### P1 — Package và quan sát lifecycle

- [x] Scaffold custom plugin, manifest, locale en-US/zh-CN, lifecycle adapter và journal/policy schema.
- [x] Observe là default; unsupported version/dialect refuses auto; recovery-required giữ runner sống/unready để operator dùng CLI.
- [x] CLI source/build entry được tách khỏi main server entry; bootstrap argv có contract smoke. Extracted artifact smoke được chạy sau build.
- [x] Unit test lifecycle, redaction, journal/policy, ACL, compatibility, lock và runner.
- [ ] Host production image chưa được dùng để chạy bootstrap.

Điều kiện qua P1: bật quan sát không thay đổi thứ tự và hành vi startup gốc; lỗi vẫn truyền đúng, không bọc lặp hoặc gán nhầm app.

### P2 — Phục hồi tự động single-node

- [x] Runner, durable campaign counter và ready/error event có boot identity; test xác nhận failed child PID khác fresh child/retry PID.
- [x] PostgreSQL adapter single-node với exact version gate, exact `updatedAt::text` CAS, policy allowlist, protected packages và direct mandatory dependency refusal.
- [x] CLI `status`, `inspect`, `approve`, `auto`, `retry`; start lazy-import supervisor/CLI-v1 env setup.
- [x] Local filesystem lock loại hai OS runner riêng biệt; policy/state mutations dùng lock riêng.
- [ ] Dependency closure mới kiểm tra enabled direct mandatory dependencies; không hỗ trợ transitive closure/peer resolution.
- [x] Optional Docker HA entrypoint/overlay chuyển qua direct Guardian runner sau install/upgrade; mode mặc định tắt và startup preflight kiểm tra topology/package/core/API.
- [ ] Chưa test operator image hoặc runtime deployment.
- [ ] Chưa có fault injection matrix cho mọi transaction/journal/IPC/child boundary.

Điều kiện qua P2: kịch bản lỗi đủ điều kiện phục hồi đúng một lần; các lỗi hạ tầng, migration, protected plugin và lỗi không rõ owner không làm disable nhầm. Không còn process con cũ và không phát readiness sớm.

### P3 — Quản trị client v1 và v2

- [x] Server resource có ACL read/manage; HTTP test xác nhận anonymous, reader, manager và mutation 403 không làm thay đổi state.
- [x] Client v1/v2 source và locale files; v2 không import `@nocobase/client`.
- [x] Server retry request dùng current revision/CAS; stale request bị từ chối.
- [ ] Browser, keyboard/a11y, end-to-end UI retry flow và frontend visual behavior chưa được kiểm chứng.

Điều kiện qua P3: user không có quyền không đọc được chẩn đoán nhạy cảm hoặc retry; admin thực hiện trọn luồng từ quarantined đến healthy/re-quarantined trên cả v1 và v2.

### P4 — HA và Kubernetes

- [x] Scope được giới hạn ở app-serving nodes có roster khai báo; `cluster init` yêu cầu operator xác nhận mọi app node đã dừng và topology app-only. Lần đầu chạy main không chờ node enrolled nhưng chưa từng hoạt động.
- [x] Dùng public Cluster Manager Redis recovery lock API và PostgreSQL control/fence rows; mutation `applicationPlugins`, receipt, campaign attempts và decision revision nằm trong cùng transaction. PostgreSQL fence commit là authority boundary; Redis expiry một mình không được coi là bằng chứng process cũ dừng.
- [x] Một coordinator tạo drain revision; mọi live/already-running enrolled boot phải ack đã dừng trước mutation. Readiness middleware giữ node chưa áp dụng decision ở HTTP 503; internal app-ready được gắn boot/revision.
- [x] Shared CLI/API hỗ trợ status, inspect, exact approve và auto với policy CAS; stale revision bị từ chối. Retry HA fail-closed và yêu cầu whole-cohort maintenance.
- [x] Test isolated PostgreSQL/Redis với hai real runner/app processes: unapproved backup fault giữ main ready; approved fault drain/update/fresh boots; sequential/concurrent starts, revision replacement, ownership fence/rollback và readiness proof.
- [x] Docker app-only overlay yêu cầu operator image và app-only roster, giữ readiness healthcheck và Guardian recovery hold behavior; shell/Compose stub checks chỉ xác nhận source contract.
- [ ] Worker/sandbox/mixed topology, unknown external DB writers, Kubernetes, production reverse proxy, rolling package upgrades và production image/runtime chưa được xác minh. Runtime từ chối role mà Cluster Manager registry báo, nhưng registry không chứng minh một process không đăng ký không tồn tại.
- [ ] Crash/Redis loss/DB outage matrix đầy đủ và network partition ngoài test harness chưa được nghiệm thu. Redis và PostgreSQL không chia sẻ một atomic transaction.

Phạm vi P4 này không đồng nghĩa với hỗ trợ HA production. Cần xác minh operator image, worker/service topology, rollout/proxy integration và chaos/runtime tests trước khi tuyên bố production HA.

### P5 — Đóng gói và local validation

- [x] ESLint `--fix`, focused TypeScript và sequential test suites; ghi kết quả trong `VALIDATION.md`.
- [x] Windows `--no-dts` builds và `npm pack` cho Guardian cùng Cluster Manager; verified manifests, locale/client/server output, external versions, extracted CLI và core-free recovery API smoke.
- [x] Không chạy workflow, release, publish, deploy hoặc rollout.

Điều kiện qua P5: phân biệt rõ test source, artifact, clean install, CI/npm publish và runtime deployment; chỉ báo thành công cho phần có bằng chứng.

### P6 — Mở rộng lỗi bootstrap, nằm ngoài cam kết MVP

- [ ] Thử nghiệm cơ chế loại package trước static import trong loader/discovery thực tế; không giả định DB disable hoặc PLUGIN_PATH đủ để chặn mọi đường import.
- [ ] Kiểm tra built-in/preset discovery, package resolution, import trực tiếp từ dependency và thứ tự staticImport.
- [ ] Đánh giá phạm vi monkey patch và khả năng tương thích trước khi chấp nhận adapter sớm; không cài global module interception nếu chưa chứng minh an toàn.
- [ ] Nếu cần hook core để bảo vệ đúng, đề xuất thay đổi upstream riêng thay vì lách quy tắc fork.

Điều kiện qua P6: chứng minh bằng child process fault injection rằng package bị cách ly không bị thực thi qua các đường đã cam kết. Không tuyên bố sandbox tuyệt đối cho plugin cùng process.

## 6. Ma trận nghiệm thu tối thiểu

| Kịch bản | Kết quả bắt buộc |
| --- | --- |
| Throw trong beforeLoad/loadCollections/loadAI/load | Đúng owner; quyết định theo policy; clean restart nếu đủ điều kiện. |
| Side effect đăng ký trước throw | Không tiếp tục dùng app dở; process mới không còn side effect từ instance cũ. |
| Guardian đăng ký cuối hoặc app reload | Vẫn bọc lifecycle được hỗ trợ, không bọc lặp. |
| Constructor/afterAdd/static import/afterStart không có attribution | Ghi nhận đúng giới hạn; không tự gán owner hoặc disable nhầm. |
| DB/Redis mất kết nối, migration lỗi | Không mass-disable; readiness false; thông tin recovery rõ ràng. |
| DB enabled=false | Không load instance DB-managed; cả hai client bỏ plugin; không khẳng định đã chặn static import. |
| Dependency bắt buộc/protected | Direct mandatory dependency từ chối quarantine; protected không bị tắt. Transitive closure chưa hỗ trợ. |
| Crash ở từng bước journal/DB | Reconcile idempotent; không mất trạng thái trước đó hoặc tự bật lại. |
| Restart process/container/pod liên tiếp | Budget tồn tại; hết budget chuyển recovery-required. |
| Admin disable đồng thời với retry | Không ghi đè quyết định admin hoặc revision mới. |
| Guardian/journal/DB adapter hỏng | Không thay đổi trạng thái plugin dựa trên dữ liệu không xác thực; có cứu hộ ngoài app. |
| Hai app node khởi động tuần tự/đồng thời | Dùng chung identity/decision; node đã active phải ack drain; peer chưa từng khởi động không gây deadlock. |
| Backup lỗi nhưng không có exact approval | Main healthy tiếp tục phục vụ và giữ nguyên boot/PID. |
| Hai app node quan sát cùng lỗi đã được duyệt | Một coordinator có fence drain các boot active, commit một quarantine chung và yêu cầu fresh readiness đúng decision revision. |
| User thường gọi API retry | Bị từ chối qua HTTP; audit không lộ bí mật. |
| Tarball cài sạch | Runner và cả client entry dùng được, không phụ thuộc workspace. |

## 7. Ranh giới nghiệm thu cuối

Bằng chứng single-node MVP bao gồm P0–P3 và các kiểm tra P5 local. Phần P4 đã triển khai là opt-in, app-only; nó không chứng nhận HA production. P6 là hạng mục riêng. Build pass, mock test hoặc DB `enabled=false` không chứng minh mọi nguyên nhân restart hay early import đã được xử lý.
