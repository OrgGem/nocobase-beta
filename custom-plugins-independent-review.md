# Review độc lập toàn bộ custom plugins

> **Cập nhật 2026-11-06:** snapshot này được đưa vào đợt commit/push theo yêu cầu. Xem [review vòng 2](custom-plugins-review-round2.md) để biết 5 finding mới còn OPEN, coverage 59 plugin và kiểm chứng trước commit. Các trạng thái working tree/build/test bên dưới mô tả thời điểm của lượt cũ.

Ngày review: 2026-11-04. Repository: `OrgGem/nocobase-beta`, nhánh `main`, commit `070854510da07be27c0ebb1e06aa7dad43fa4efc`, NocoBase `2.2.37`.

> **Cập nhật sau sửa ngày 2026-11-04:** các mô tả lỗi và số test bên dưới là snapshot trước sửa. Trạng thái xử lý từng plugin, bằng chứng regression/build/pack và phần chưa kiểm chứng được ghi riêng tại [custom-plugins-fix-status.md](custom-plugins-fix-status.md). IR-02 đã được hiệu chỉnh về khả năng đi tới handler qua HTTP; không dùng probe gọi trực tiếp handler làm bằng chứng khai thác HTTP mặc định.

## Kết luận

Snapshot review xác nhận **17 finding: 9 P1 và 8 P2, ảnh hưởng 20/59 custom plugin**. Trong 9 P1 có 8 vấn đề phân quyền/xác thực và 1 lỗi thiếu module server; P1 của IR-02 là ưu tiên phòng thủ tại handler, có điều kiện reachability như phần hiệu chỉnh bên dưới. Chưa có bằng chứng về khai thác trên hệ thống đang chạy. Trạng thái sau sửa nằm trong tài liệu theo dõi được liên kết ở trên.

Đây là review mới từ source và contract của core tại commit trên; không dùng kết luận hoặc số lượng lỗi của `custom-plugins-v2-review.md` làm bằng chứng. Không sửa source, core, base plugin, database, cấu hình dịch vụ hoặc `dist/` trong lượt review này.

P1 = cần ưu tiên sửa trước phát hành vì có thể vượt quyền hoặc chặn build/load. P2 = lỗi chức năng hoặc contract cần sửa có kiểm thử. Không đưa số lượng `any`, file dài, thiếu test hay khác biệt manifest đơn thuần vào tổng finding sản phẩm.

| ID | Mức | Plugin | Vấn đề |
| --- | --- | --- | --- |
| IR-01 | P1 | oidc-auth | Liên kết tài khoản theo email chưa xác minh, kể cả khi cấu hình yêu cầu xác minh |
| IR-02 | P1 | block-cross-join | Đọc collection/field do người gọi chỉ định mà không áp ACL dữ liệu |
| IR-03 | P1 | database-plus-manager | Đổi collection sau bước kiểm tra ACL của action `list` |
| IR-04 | P1 | microsoft-graph-gateway | Tài khoản thường có thể cấp API key quyền ghi và sửa cấu hình toàn cục |
| IR-05 | P1 | file-preview-auth | CRUD trực tiếp OCR result bỏ qua kiểm tra quyền attachment |
| IR-06 | P1 | ai-browser | Generic list/get làm lộ profile/session của người khác |
| IR-07 | P1 | package-registry | `authRequired=true` không được thực thi ở npm router |
| IR-08 | P1 | s3-private-storage, sftp-private-storage, file-preview-auth | Nhánh không có collection cha bỏ qua bộ lọc quyền theo bản ghi |
| IR-09 | P1 | ai-drawio | Import module server không tồn tại |
| IR-10 | P2 | data-cloner | Placeholder `?` không khớp cơ chế `bind`, làm hỏng các chunk tiếp theo |
| IR-11 | P2 | data-cloner | Task vẫn thành `completed` khi table đã `error` |
| IR-12 | P2 | block-cross-join | Server/client không thống nhất response envelope |
| IR-13 | P2 | file-search | Đăng ký handler nhưng chưa định nghĩa resource `fileSearch` |
| IR-14 | P2 | oidc-auth | Lưu form v2 làm mất option OIDC không được khai báo trong form |
| IR-15 | P2 | carbone-template-manager | Snippet tổng hợp chứa tên snippet con thay vì action |
| IR-16 | P2 | data-source-elasticsearch, data-source-mssql | Thiếu đăng ký xóa collection trong v2 |
| IR-17 | P2 | docker-registry-ui, skill-registry, selector-registry, user-memory, idp-oidc-client-manager | Tên ACL snippet client/server lệch nhau dưới quy tắc tên plugin mặc định |

## Phạm vi và bằng chứng

- Phạm vi custom: toàn bộ **59 thư mục `packages/plugins/plugin-*`**. `@nocobase` và `@nocobase-example` được dùng làm contract/tham chiếu, không nằm trong tổng custom; không có nhóm custom top-level khác trong checkout này.
- Kiểm kê **2.185 file source** và **378 file test**: 22 client v1, 72 client v2, 282 server, 2 ngoài hai lane client/server.
- Quét AST/import toàn bộ source: không có lỗi cú pháp parser TypeScript; không phát hiện import trực tiếp `@nocobase/client` từ `src/client-v2`. Đây không phải semantic typecheck hay chứng nhận không có phụ thuộc v1 gián tiếp.
- Duyệt graph import của **59 server entry** bằng esbuild, `bundle: true`, `packages: external`, `write: false`: **58 thành công, 1 thất bại** ở AI Drawio. Cách kiểm tra này không thay thế native plugin build, dependency packaging hoặc chạy ứng dụng.
- Đọc registration/lifecycle, theo đường gọi các endpoint và kiểm tra core ACL, ResourceManager, response wrapping, plugin naming, FlowModel và v2 datasource/auth forms. Đọc sâu hơn ở nơi có dữ liệu nhạy cảm, API công khai hoặc thao tác quản trị. Không coi quét AST là đọc thủ công từng dòng.
- **10 probe Node**, **6 probe server Vitest**, **1 probe client Vitest** đã tái hiện các contract/nhánh lỗi được nêu. Probe dùng repository/context giả và source thật; không gọi IdP, Graph, S3/SFTP hoặc database đang chạy. Test probe “pass” nghĩa là đã tái hiện lỗi hiện tại, không có nghĩa source đã được sửa.

### Kết quả test sẵn có

| Phạm vi | Kết quả quan sát |
| --- | --- |
| Client v1 + v2, toàn bộ 94 file | 93 file pass, 1 file fail; **383 test pass, 1 fail** |
| Server, 241 file được chọn, chạy tuần tự | 224 file pass, 17 file fail; Vitest báo **1.820 test pass, 19 fail, 3 skipped**; tổng discovered 2.001 còn bao gồm các test không hoàn tất do suite setup lỗi |
| 41 file server còn lại | Chưa chạy trong lượt này; chủ động tách nhóm có dấu hiệu cần database/integration. Bộ lọc ban đầu không nhận ra helper DB của API Manager, nên 10 suite thuộc nhóm đã chạy vẫn bị chặn ở setup |
| 2 test ngoài lane client/server | Chưa chạy |

Các lỗi test cần được xử lý riêng, không cộng tất cả vào 17 finding sản phẩm:

| Nhóm lỗi | Phân loại từ source/log |
| --- | --- |
| Field Selection Filter: 1 client test | `src/client/__tests__/plugin.test.ts:207` đòi class v1 và v2 phải cùng identity. Hai entry hiện export hai class riêng; chưa có bằng chứng assertion này chứng minh lỗi runtime |
| API Manager: 10 server suite | Setup thất bại do thiếu `sqlite3`; kiểm tra `require('sqlite3')` cũng trả `MODULE_NOT_FOUND`. Có thêm teardown lỗi vì app chưa tạo được. Không kết luận các API tương ứng pass hoặc fail chức năng |
| API Manager: `pgp-rsa-sanity.test.ts` | Không có test suite, Vitest báo `No test suite found` |
| Agent Orchestrator: 14 assertion fail trong 2 file | Source hiện gọi `agentLoopSteps.count()` tại `LoopWorkerService.ts:879`; hai `MemoryRepository` fixture không có `count()`. Luồng test dừng trước các assertion về maker/approval/lock; cần cập nhật fixture rồi xác minh lại runtime |
| SFTP: 2 assertion fail | Test giả định bỏ `SFTP_STORAGE_SECRET_KEY` và JWT file sẽ tới ephemeral key; source còn fallback `APP_KEY`, được test setup khởi tạo. Chưa phải bằng chứng production bỏ qua encryption |
| Skill Registry: 2 publish assertion fail | Mock `get()` trả chuỗi version cho mọi field, bao gồm `publishedAt`; `versionResponse()` chuyển chuỗi đó thành ngày và lỗi. Cần fixture đúng kiểu dữ liệu |
| Skill Registry: 1 candidate-limit assertion fail | Test dùng 1.001 item để vượt ngưỡng cũ; source hiện mặc định 5.000. Kiểm tra duplicate vẫn có trong source |

Không chạy browser E2E, full semantic TypeScript, native build/pack toàn bộ plugin, PostgreSQL/MSSQL thật, Redis/cluster thật hoặc các dịch vụ bên ngoài. Vì vậy các plugin chưa có finding bên dưới chỉ có nghĩa **chưa xác nhận lỗi trong phạm vi đã kiểm tra**.

## Finding chi tiết

### IR-01 — P1: OIDC liên kết email chưa xác minh với tài khoản có sẵn

**Vị trí:** `packages/plugins/plugin-oidc-auth/src/server/oidc-auth.ts:76` và `:249`.

`validateEmailClaims()` chỉ kiểm tra domain; không kiểm tra `email_verified` hay `requireVerifiedEmail`. `provisionUser()` sau đó tìm user theo email và `addUser()` liên kết `issuer|sub` mới với user đó. Khi IdP cho phép một người đăng ký email chưa xác minh trùng tài khoản NocoBase, người đó có thể được liên kết vào tài khoản sẵn có nếu bật bind theo email. `autoSignup=false` không chặn nhánh liên kết này.

**Bằng chứng:** probe gọi source thật với `email_verified=false`, `requireVerifiedEmail=true`, `bindExistingUserByEmail=true`, `autoSignup=false`; `addUser(99, ...)` vẫn được gọi cho user giả có cùng email. Đây là nhánh provisioning được tái hiện, chưa phải một phiên đăng nhập IdP thật.

**Sửa/kiểm chứng:** bắt buộc email đã xác minh trước khi liên kết user có sẵn; tách chính sách cho phép tạo user mới chưa xác minh khỏi chính sách liên kết tài khoản. Test trường hợp claim true/false/absent, cấu hình bật/tắt và danh tính đã liên kết; không làm hỏng login bằng `issuer|sub` đã tin cậy.

### IR-02 — P1: Cross Join truy vấn dữ liệu ngoài quyền của người gọi

**Vị trí:** `plugin-block-cross-join/src/server/plugin.ts:28`; `src/server/actions/cross-join-query.ts:141`, `:165`, `:191`, `:208` trong `packages/plugins/`.

`crossJoin:query` được `loggedIn` cho phép. Handler lấy datasource, collection và field từ payload rồi gọi repository trực tiếp; không kiểm tra quyền collection, filter theo role hoặc whitelist field cho primary/join. Khi `columns` rỗng, toàn bộ field lấy được được trả về. Nếu request tới được handler, payload có thể chỉ định collection mà API list thông thường không cho đọc.

**Bằng chứng:** fake ACL luôn deny nhưng handler không gọi ACL lần nào; một record giả trong collection bị hạn chế vẫn xuất hiện trong response. Core `AllowManager` xác nhận `loggedIn` là điều kiện bỏ qua ACL mặc định, không phải kiểm tra quyền dữ liệu.

**Hiệu chỉnh từ HTTP integration khi sửa:** core ACL còn đăng ký pre-action chung tên `query`, kiểm tra schema truy vấn SQL. Payload Cross Join thông thường bị guard này từ chối trước handler với role thường. Probe trên chỉ chứng minh thiếu ACL bên trong handler; không chứng minh tài khoản thường khai thác được đường HTTP mặc định. Bản sửa đăng ký pre-action riêng `crossJoin:query` để nhận đúng schema join, đồng thời giải ACL collection/row/field cho mọi nguồn trước truy vấn. HTTP regression xác nhận dữ liệu hợp lệ trả 200, collection hoặc cột không được cấp quyền trả 403.

**Sửa/kiểm chứng:** giải quyền read cho từng nguồn, áp cả filter và field restriction trước truy vấn; re-check mọi join. Test hai role, dữ liệu cùng collection nhưng khác owner, field bị cấm và datasource ngoài main.

### IR-03 — P1: Cursor pagination thay collection sau ACL

**Vị trí:** `plugin-database-plus-manager/src/server/plugin.ts:41`; `src/server/resources/database-plus-manager.ts:38` và `:54`.

Pre-action `list` được gắn `after: 'acl'`, nhưng `cursorPaginationAction()` ưu tiên `params.collection` thay cho resource đã được ACL kiểm tra. Người có quyền list một collection với phạm vi đủ rộng có thể gửi `paginationMode=cursor&collection=<collection-khac>` để đọc repository khác. Các field/filter còn lại thuộc resource ban đầu; truyền `context: ctx` vào repository không đánh giá lại quyền resource mới.

**Bằng chứng:** handler nhận `resourceName=permitted_review_fixture`, nhưng gọi repository `restricted_review_fixture` và trả record giả. Core ResourceManager giữ các query parameter khi merge action params.

**Sửa/kiểm chứng:** interceptor phải dùng đúng collection/resource đã được duyệt; nếu standalone cursor API nhận collection riêng thì tự giải lại ACL cho collection đó. Test cố đổi collection, datasource và association resource.

### IR-04 — P1: Graph Gateway mở thao tác quản trị cho mọi user đăng nhập

**Vị trí:** `plugin-microsoft-graph-gateway/src/server/plugin.ts:224` và `:350`.

`saveSettings`, `createApiKey`, `revokeApiKey`, `listApiKeys` cùng nhiều action quản trị được allow bằng `loggedIn`. `createApiKey()` chỉ kiểm tra scope có nằm trong danh sách hợp lệ, không kiểm tra quyền cấp scope; snippet `pm.microsoft-graph-gateway` không thu hẹp allow này. Một user thường có thể tạo key `email:write`/`drive:write` để sử dụng năng lực của service principal đã cấu hình, hoặc thay đổi cấu hình dùng chung.

**Bằng chứng:** probe tạo key quyền ghi trong fake repository với role `member`, không có admin grant. Không gọi Microsoft Graph hoặc lưu key vào hệ thống thật.

**Sửa/kiểm chứng:** bảo vệ action quản trị bằng snippet/ACL quản trị thực sự; giữ cơ chế API key riêng cho external action. Test user thường bị 403, admin cấp/revoke key thành công và scope của key vẫn được thực thi.

### IR-05 — P1: CRUD OCR result bỏ qua quyền attachment

**Vị trí:** `plugin-file-preview-auth/src/server/plugin.ts:460`; collection `src/server/collections/attachment-ocr-results.ts:3`.

Custom `runOcr/getOcrStatus` gọi `assertCanAccessAttachment`, nhưng generic `attachmentOcrResults:get/list/create/update` đều được allow cho `loggedIn`. Không có owner/data-scope hook tương ứng cho generic resource. User có thể đọc nội dung OCR của attachment ngoài quyền, hoặc thay `data/status` mà không đi qua kiểm tra attachment.

**Bằng chứng:** theo registration → collection → generic action; probe core AllowManager xác nhận tài khoản thường qua được cả `list` và `update`. Chưa chạy HTTP/DB thật cho đường CRUD này.

**Sửa/kiểm chứng:** đóng CRUD công khai hoặc thêm kiểm tra attachment trên từng record, bao gồm bulk request; không cho client tự ghi kết quả OCR nếu không có nghiệp vụ rõ ràng. Test tài khoản A không đọc/sửa OCR của file B, kể cả khi biết ID.

### IR-06 — P1: AI Browser cho đọc session/profile của người khác

**Vị trí:** `plugin-ai-browser/src/server/plugin.ts:64`; `src/server/collections/ai-browser-profiles.ts:39`; `src/server/services/BrowserProfileService.ts:43`.

Generic list/get của profiles, sessions, tasks, action events và workflow caches được allow `loggedIn`, không áp owner filter. Profile có field `cookies`/`localStorage`; session có URL và thông tin phiên. Kiểm tra owner trong các custom action screenshot/stop không bảo vệ generic REST. Filter owner ở service cũng không tự chạy khi gọi collection API.

**Tác động:** lộ dữ liệu hoạt động của người khác; profile có lưu trạng thái đăng nhập còn có thể làm lộ credential/session material. Không giả định mọi profile đều đã lưu cookie.

**Bằng chứng:** source registration/collection/service và probe AllowManager; chưa tải profile thật hoặc gọi live browser.

**Sửa/kiểm chứng:** áp owner/admin scope cho mọi read path; không serialize cookie/localStorage hoặc endpoint có secret cho người dùng không có quyền. Test list, get, appends và filterByTk giữa hai chủ sở hữu.

### IR-07 — P1: Package Registry bỏ qua `authRequired`

**Vị trí:** `plugin-package-registry/src/server/registry-router.ts:58`, `:145`, `:206`; `src/server/collections/packageRegistries.ts:37`.

Router npm xử lý GET metadata/tarball trực tiếp; không đọc `authRequired`, không xác thực người gọi hoặc quyền registry. Flag true trong collection không thay đổi hành vi. ACL của resource quản trị `packageRegistry` không bảo vệ đường router này.

**Bằng chứng:** router source trả metadata của registry giả `authRequired=true` khi context không có user/header đăng nhập. Đường tarball dùng cùng lookup không có bước xác thực; chưa tải artifact thật.

**Sửa/kiểm chứng:** thực thi chính sách registry trước cả metadata và tarball/proxy-cache lookup. Test anonymous bị chặn với registry private, public vẫn đọc được, user/token đúng phạm vi đọc được.

### IR-08 — P1: Ba plugin file bỏ qua data scope khi không có collection cha

**Vị trí:** `plugin-s3-private-storage/src/server/plugin.ts:155`; `plugin-sftp-private-storage/src/server/plugin.ts:249`; `plugin-file-preview-auth/src/server/plugin.ts:651`.

Trong `checkParentCollectionAccess()`, khi không tìm thấy quan hệ cha, code trả `!!canView`. Một grant `view` có `params.filter` giới hạn “file của tôi” vẫn là object truthy; record/file đích chưa được đối chiếu filter. User không phải creator có thể đọc file ngoài phạm vi khi file collection không có quan hệ cha mà hàm reverse-lookup nhận diện được. Nhánh có parent đã có truy vấn data-scope; lỗi nằm ở fallback.

**Bằng chứng:** ba probe gọi đúng method source với ACL chỉ cho `createdById=7`, file ID khác, không có parent. Cả ba trả true mà không truy vấn kiểm tra record dưới filter. Chưa stream dữ liệu S3/SFTP thật.

**Sửa/kiểm chứng:** fallback phải kiểm tra ID file cùng filter/field scope đã render cho user; không chỉ kiểm tra có grant. Test cả không có parent, có parent nhưng record không thuộc quyền, creator hợp lệ và root.

### IR-09 — P1: AI Drawio thiếu module trong server import graph

**Vị trí:** `plugin-ai-drawio/src/server/actions/getSystemPrompt.ts:2`.

File import `../lib/system-prompt`, nhưng source không có module này; server index → plugin → action đi qua import đó. Không có bước sinh file tương ứng trong package manifest.

**Bằng chứng:** esbuild resolve graph server từ source báo `Could not resolve "../lib/system-prompt"`; đây cũng là server entry duy nhất thất bại trong 59 entry. Chạy với `write:false`, không ghi đè bundle hiện có.

**Sửa/kiểm chứng:** khôi phục module hoặc trỏ đến nguồn prompt thật, rồi chạy native build và smoke load server. `dist/` cũ còn chạy được, nếu có, không chứng minh source hiện tại build được.

### IR-10 — P2: Data Cloner dùng sai placeholder cho `bind`

**Vị trí:** `plugin-data-cloner/src/server/services/CloneEngineService.ts:102` và `:145`.

Query chunk tiếp theo chứa `WHERE <column> > ?`, nhưng được gọi bằng `{ bind: [...] }`. Formatter bind của Sequelize đang cài xử lý ký hiệu `$1`/named bind; không thay `?` theo cách code này cần. Clone có thể qua chunk đầu rồi lỗi ở chunk sau; resume từ checkpoint cũng gặp lỗi.

**Bằng chứng:** query do source sinh được đưa qua formatter MSSQL thật của Sequelize; kết quả vẫn chứa `?`, tập bind parameter rỗng. Không kết nối SQL Server.

**Sửa/kiểm chứng:** dùng placeholder bind đúng contract hoặc dùng replacements nhất quán. Test ít nhất hai chunk và resume trên từng dialect được hỗ trợ, với khóa có kiểu số/chuỗi phù hợp.

### IR-11 — P2: Data Cloner báo hoàn tất sau lỗi table

**Vị trí:** `plugin-data-cloner/src/server/services/CloneEngineService.ts:56`, `:69`, `:79`.

Worker bắt lỗi và đánh dấu table `error`, nhưng không truyền trạng thái lỗi lên task. Sau `Promise.allSettled`, task luôn thành `completed` nếu không paused. Người dùng có thể hiểu một lần clone dữ liệu thiếu là đã hoàn tất.

**Bằng chứng:** ép `syncTable()` ném lỗi giả; table kết thúc `error`, task đi qua `running → completed`.

**Sửa/kiểm chứng:** tổng hợp kết quả table/worker trước khi quyết định task status; không đánh `completed` nếu còn lỗi. Test một table lỗi trong nhiều table, worker rejection, pause và retry.

### IR-12 — P2: Cross Join nhận response bọc hai lớp

**Vị trí:** `plugin-block-cross-join/src/server/actions/cross-join-query.ts:236`; `src/client-v2/CrossJoinBlockModel.tsx:65`.

Handler trả `{ data, meta }` nhưng không tắt core data wrapping. Core bọc tiếp thành `{ data: { data, meta } }`. Model client chỉ đọc `res.data.data` và `res.data.meta`: `_data` trở thành object, `_total` bằng 0; nhánh render có thể hiện “No data” dù query có kết quả.

**Bằng chứng:** chạy handler với repository giả rồi middleware `packages/core/server/src/middlewares/data-wrapping.ts` thật; kiểm tra data không còn là array tại vị trí client đang đọc.

**Sửa/kiểm chứng:** thống nhất response theo `{rows, ...meta}` của core hoặc đánh dấu raw envelope phù hợp; test qua middleware thật và assertion data/pagination ở model.

### IR-13 — P2: File Search chưa định nghĩa resource cho HTTP API

**Vị trí:** `plugin-file-search/src/server/plugin.ts:21`.

Plugin chỉ `registerActionHandlers('fileSearch:...')`, không `define({name:'fileSearch', ...})`; cũng không có collection `fileSearch` tự tạo resource. Core vẫn gọi `getResource()` trước khi lấy handler, nên search/overview/reindex qua HTTP không tới được handler. AI tool gọi handler trực tiếp và mock load test chỉ kiểm tra registration nên có thể che mất lỗi.

**Bằng chứng:** probe ResourceManager thật cho kết quả `fileSearch resource does not exist` sau register handler; định nghĩa resource rồi mới lấy được action. Đã kiểm tra không có nơi khác trong source định nghĩa resource này.

**Sửa/kiểm chứng:** định nghĩa resource rõ ràng trong plugin; test HTTP search/overview với core resourcer, giữ ACL cho từng action.

### IR-14 — P2: Form OIDC v2 làm mất option chưa render

**Vị trí:** `plugin-oidc-auth/src/client-v2/OIDCAdminSettings.tsx:17`; contract liên quan ở `@nocobase/plugin-auth/src/client-v2/pages/AuthenticatorsPage.tsx:175`.

Form khai báo một phần `options.oidc`; `validateFields()` chỉ trả các field đã khai báo. Form host merge `options` ở mức đầu nên object `oidc` mới thay object cũ, làm mất `fieldMap`, `idTokenSignedResponseAlg`, `http`, `port` nếu đã cấu hình. Server update lưu values được gửi, không deep-merge các key này. Chỉ sửa một nhãn/cấu hình thông thường cũng có thể thay đổi mapping/thuật toán/redirect của authenticator.

**Bằng chứng:** render form plugin thật trong Ant Design, validate rồi áp đúng merge của host: `fieldMap` và `idTokenSignedResponseAlg` đã có trong initialValues đều biến mất. Chưa chạy phiên login sau lưu.

**Sửa/kiểm chứng:** bảo toàn hoặc khai báo các option plugin sở hữu trong form v2. Giữ core/base plugin read-only theo AGENTS; nếu muốn sửa contract chung ở base cần một yêu cầu riêng. Test edit/save/reload authenticator có advanced options.

### IR-15 — P2: Carbone dùng snippet con như action

**Vị trí:** `plugin-carbone-template-manager/src/server/plugin.ts:166`.

Snippet `pm.<name>.settings` có `actions` là các chuỗi `pm.<name>.connection/templates/...`. Core SnippetManager chỉ match từng chuỗi với `resource:action`, không mở rộng snippet lồng nhau. Role được cấp Settings có thể thấy trang nhưng API tương ứng vẫn bị 403 nếu không được cấp thêm từng snippet con. Root/all-permissions che được lỗi này.

**Bằng chứng:** probe SnippetManager thật: cấp snippet cha không cho `carboneSettings:get`, cấp snippet con mới cho.

**Sửa/kiểm chứng:** khai báo tập action thực của snippet tổng hợp hoặc quản lý nhóm quyền ở cấp phù hợp. Test role chỉ được cấp snippet Settings, không dùng root.

### IR-16 — P2: MSSQL/Elasticsearch v2 thiếu thao tác xóa collection

**Vị trí:** `plugin-data-source-mssql/src/client-v2/plugin.tsx:18`; `plugin-data-source-elasticsearch/src/client-v2/plugin.tsx:9`.

V1 đăng ký `DeleteCollection` và `allowCollectionDeletion:true`; v2 bỏ cả hai. Core v2 CollectionsPage chỉ render nút cho datasource ngoài main khi có đủ cờ và component này (`CollectionsPage.tsx:1251`, `:1797`). Vì vậy người dùng v2 không còn thao tác gỡ/xóa collection qua UI như v1. Không có bằng chứng ở finding này rằng dữ liệu nguồn đã bị xóa nhầm.

**Sửa/kiểm chứng:** cung cấp component v2 đúng contract và cờ cho phép, giữ rõ ngữ nghĩa metadata/cascade. Test thao tác xác nhận/hủy và request tới đúng datasource; không import component v1 vào v2.

### IR-17 — P2: Năm plugin dùng tên ACL snippet không thống nhất

**Vị trí:** client `plugin-docker-registry-ui/src/client-v2/permissions.ts:3`, `plugin-skill-registry/src/client-v2/permissions.ts:12`, `plugin-selector-registry/src/client-v2/permissions.ts:11`, `plugin-user-memory/src/client-v2/plugin.tsx:4`, `plugin-idp-oidc-client-manager/src/client-v2/plugin.tsx:4`.

Client dùng `pm.skill-registry.*`, `pm.user-memory.admin`, v.v. Server đăng ký `pm.${this.name}.*` (`docker-registry-ui/server/plugin.ts:47`, `skill-registry/server/plugin.ts:213`, `selector-registry/server/plugin.ts:79`, `user-memory/server/plugin.ts:245`, `idp-oidc-client-manager/server/plugin.ts:104`, đều dưới `src/`). Với package unscoped `plugin-...`, quy tắc tên mặc định giữ tiền tố `plugin-`, nên tên thật là `pm.plugin-skill-registry.*`, v.v.

**Tác động:** role được cấp chính xác snippet một phía có thể bị ẩn menu/nút hoặc API 403 ở phía kia. Cấp root/`pm.*` hoặc cấu hình prefix tùy chỉnh có thể che lỗi; không giả định tất cả installation hiện tại dùng cùng alias.

**Bằng chứng:** kiểm tra constants/registration và chạy `parsePluginName()` core với prefix mặc định trên cả năm package: tên server đều giữ `plugin-`.

**Sửa/kiểm chứng:** dùng một namespace quyền thống nhất cho client/server; xử lý grant cũ khi đổi tên. Test plugin load bằng package name thật và role chỉ có grant tối thiểu, không mock tên server đã rút gọn.

## Thứ tự xử lý đề xuất

1. **Đóng các đường vượt quyền:** IR-01 → IR-08. Tạo ma trận user A/user B/admin, record thuộc/không thuộc quyền và field nhạy cảm. Kiểm thử HTTP qua auth + ACL + resourcer thật; mock probe hiện tại chỉ là bằng chứng nhánh lỗi.
2. **Khôi phục khả năng build và dữ liệu đúng:** IR-09 → IR-13. Sửa module Drawio, clone nhiều chunk và trạng thái task, envelope Cross Join, resource File Search. Không pack từ dist cũ khi build thất bại.
3. **Hoàn thiện contract v2/quyền tối thiểu:** IR-14 → IR-17. Test lưu lại cấu hình, xóa collection qua v2 và role không phải root.
4. **Gỡ các blocker xác minh:** chuẩn hóa fixture/test lỗi ở trên; chuẩn bị SQLite test dependency, sau đó chạy 41 server file còn lại và các suite setup thất bại tuần tự. Chạy semantic TypeScript, native build `--no-dts`, kiểm tra bundle/locale/externalVersion rồi mới pack. E2E riêng cho IdP, Graph, database ngoài, storage và cluster; chỉ đánh hoàn tất phạm vi nào có kết quả thực tế.

## Ma trận bao phủ 59 plugin

Mọi dòng đều đã được kiểm kê source, kiểm tra AST/import và resolve server entry. Cột C/S là **file test pass / file test đã chọn chạy**, không phải phần trăm dòng code được cover. `—` nghĩa là không chạy file test ở lane đó. Finding trống không phải xác nhận plugin an toàn hoàn toàn.

| Plugin | Source | C pass/chạy | S pass/chạy | Finding / phạm vi bổ sung |
| --- | ---: | ---: | ---: | --- |
| plugin-advance-charts | 24 | 2/2 | — | Chart registration, model/utility tests |
| plugin-advance-settings | 13 | — | 1/1 | Settings/Help registration; chưa E2E search |
| plugin-agent-orchestrator | 170 | 1/1 | 30/32 | Owned runs/approvals, execution scope; fixture count() cần sửa |
| plugin-ai-api | 73 | 3/3 | 26/26 | Permission, quota, stored response/owner contracts; DB integration còn mở |
| plugin-ai-browser | 55 | 2/2 | — | **IR-06**. Generic read và owner checks của custom actions |
| plugin-ai-chat-file-preview | 9 | 2/2 | — | Chat interception và FlowEngine context; chưa browser E2E |
| plugin-ai-drawio | 57 | 5/5 | — | **IR-09**. Server import graph lỗi; client tests vẫn pass |
| plugin-antd-style-theme | 339 | 2/2 | — | Theme entry, per-user settings và serialization tests |
| plugin-api-manager | 58 | 1/1 | 12/23 | Gateway entry/ACL; 10 suite thiếu sqlite3, 1 file không có test |
| plugin-app-observability | 45 | 3/3 | 14/14 | Metrics token, lifecycle, query/retention contracts |
| plugin-block-cross-join | 17 | — | — | **IR-02, IR-12**. Datasource query, ACL và response/model contract |
| plugin-block-embed-settings | 26 | 8/8 | — | Embed settings/schema selection và native registration |
| plugin-block-json | 16 | 1/1 | — | Flow model registration/render contract |
| plugin-block-timeline | 17 | 1/1 | — | Datasource/model registration, timeline model tests |
| plugin-build-guide-block | 33 | — | — | getHtml/getMarkdown, build sanitization; chưa app integration |
| plugin-build-ui-template | 10 | — | — | Build action/queue lifecycle; chưa tích hợp AI thật |
| plugin-build-visualization-block | 42 | 3/3 | 4/4 | Result owner check, settings/build contracts |
| plugin-carbone-template-manager | 58 | — | — | **IR-15**. ACL snippet, workflow/settings registration; chưa Carbone thật |
| plugin-cluster-manager | 84 | 1/1 | 6/6 | Health/admin registration, lock/allocator contracts; chưa đa node |
| plugin-crypto-toolkit | 38 | — | 9/9 | Private-material hooks, crypto/resource contracts; chưa DB smoke |
| plugin-custom-llm | 16 | — | 1/1 | Provider registration/adaptation; chưa model endpoint thật |
| plugin-data-cloner | 17 | — | — | **IR-10, IR-11**. SQL chunks, worker/table/task status |
| plugin-data-source-elasticsearch | 14 | 2/2 | 1/1 | **IR-16**. V1/v2 datasource contract, server repository tests |
| plugin-data-source-mssql | 17 | 1/1 | 6/6 | **IR-16**. V1/v2 datasource contract; chưa SQL Server integration |
| plugin-database-plus-manager | 30 | 1/1 | 5/5 | **IR-03**. Pre-list interceptor, cursor/filter/index/SQL utilities |
| plugin-docker-registry-ui | 44 | 9/9 | 8/8 | **IR-17**. Read/write snippets, request policy/normalization tests |
| plugin-document-parser | 34 | — | 4/4 | Provider/engine/config contracts; chưa worker/service thật |
| plugin-document-understanding | 28 | — | 4/4 | Pipeline/resource entry và executor tests |
| plugin-embed-web-client | 24 | — | — | Config masking, model serving/path checks; chưa browser/model thật |
| plugin-external-storage-manager | 24 | 1/1 | 8/8 | Directory data scope, signed-download binding và path handling |
| plugin-field-fast-render | 10 | 1/1 | — | Native Flow registration và bundle entry |
| plugin-field-selection-filter | 9 | 1/2 | — | Flow registration/filter tests; 1 test identity v1/v2 fail |
| plugin-field-style-format | 12 | 1/1 | — | Table-column flow và rendering options |
| plugin-file-preview-auth | 18 | 2/2 | 1/1 | **IR-05, IR-08**. Attachment checks, OCR generic APIs, fallback file scope |
| plugin-file-search | 31 | 2/2 | 2/2 | **IR-13**. Resource registration, client API URLs và search access helper |
| plugin-git-manager | 52 | — | 10/10 | Read/write snippets, command/path/redaction tests; chưa Git remote thật |
| plugin-ha-scheduler | 9 | — | 1/1 | Cron patch/cleanup; distributed-lock test chưa chạy |
| plugin-hashicorp-vault-integration | 18 | 1/1 | 2/2 | resolve/listKeys giới hạn exposeToClient; chưa Vault thật |
| plugin-header-style-format | 9 | 1/1 | — | Header/table flow registration |
| plugin-idp-oidc-client-manager | 20 | 1/1 | — | **IR-17**. Client/admin API snippet contract; service test chưa chạy |
| plugin-knowledge-base | 57 | — | 15/15 | Resource access/manage checks, document owner/role policy; chưa vector DB thật |
| plugin-microsoft-graph-gateway | 23 | 2/2 | 2/2 | **IR-04**. Admin/API-key flow, external scope/cursor checks |
| plugin-n8n | 51 | 1/1 | — | Proxy resource/ACL entry và masking; chưa n8n thật |
| plugin-next-app-client | 31 | 5/5 | 1/1 | Accessible routes/config entry, hub route contracts |
| plugin-ocr-verify-block | 42 | 4/4 | — | Explicit collection/field ACL trong verify handler; chưa DB smoke |
| plugin-oidc-auth | 18 | 2/2 | 2/2 | **IR-01, IR-14**. Identity linking, email policy và v2 save payload |
| plugin-package-registry | 17 | — | — | **IR-07**. Npm router, registry auth flag và metadata/tarball lookup |
| plugin-router-configuration | 11 | 3/3 | 1/1 | Canonical alias/registration; SQLite alias integration chưa chạy |
| plugin-s3-private-storage | 18 | 1/1 | 9/9 | **IR-08**. Stream authentication, parent/data-scope fallback, adapter tests |
| plugin-selector-registry | 43 | — | 10/10 | **IR-17**. ACL name/read/manage contract; DB integration chưa chạy |
| plugin-sftp-private-storage | 16 | — | 5/7 | **IR-08**. Stream data scope/encryption; 2 fixture-env assertions fail |
| plugin-sftpgo-integration | 21 | — | 2/2 | Admin resource/credential contracts; chưa SFTPGo thật |
| plugin-shared-forms | 41 | 6/6 | 2/2 | Share role/schema flow và migration; 2 declaration imports còn cần typecheck |
| plugin-skill-creator | 8 | — | — | Server skill-template registration; v2 entry rỗng có chủ đích |
| plugin-skill-pptx-advanced | 8 | — | — | Server skill-template registration; chưa thực thi worker/template |
| plugin-skill-registry | 69 | 4/4 | 19/21 | **IR-17**. Public/admin/permission/source contracts; 3 fixture/limit assertions fail |
| plugin-uipath-orchestrator | 54 | 2/2 | — | Resource/admin/webhook registration; chưa UiPath/webhook E2E |
| plugin-user-memory | 20 | 1/1 | 1/1 | **IR-17**. User/admin registration và sync contracts |
| plugin-visualization-templates | 17 | 3/3 | — | Dashboard/template registration và API adapter tests |

## Bằng chứng có thể xem lại trong phiên làm việc

Các file dưới đây nằm trong `%TEMP%`, không được thêm vào source plugin. Chúng là bằng chứng cục bộ của lượt review, không phải CI artifact hay kết quả triển khai:

- `independent-plugin-inventory.json`: danh sách 59 plugin, file source và test theo lane.
- `independent-plugin-scans.json`: AST/import scan; ngoài lỗi Drawio còn có 2 import declaration tương đối lỗi ở `plugin-shared-forms/src/client/client.d.ts`, chưa đưa thành lỗi runtime.
- `independent-custom-server-resolution.json`: kết quả resolve 59 server entry với esbuild, không ghi bundle.
- `independent-custom-client-vitest.log`: 94 file client, 383/384 test pass.
- `independent-custom-server-vitest.log`: 241 file server và lỗi chi tiết.
- `independent-plugin-server-selected.json`, `independent-plugin-server-db-tests.json`: danh sách server file đã chọn/chưa chạy.
- `independent-custom-plugin-probes.cjs`, `independent-custom-plugin-probes.json`: 10 probe Node và kết quả.
- `independent-custom-contracts.test.ts`, `independent-custom-contracts.log`: 6 probe server, gồm File Search, AllowManager, ba file fallback và OIDC linking.
- `independent-oidc-client.test.tsx`, `independent-oidc-client.log`: probe mất nested OIDC options.
- Config chạy tương ứng: `independent-custom-client-vitest.mjs`, `independent-custom-server-vitest.mjs`, `independent-oidc-client-vitest.mjs`.

Lệnh chính: `yarn test:client --config <client-config> --run`, `yarn test --config <server-config> --run`, `node <probe.cjs>`. Server test dùng một worker, `.env` rỗng riêng, storage tạm và SQLite `:memory:`; không dùng database của ứng dụng đang chạy.

Kiểm tra tài liệu: đã chạy `yarn eslint --fix custom-plugins-independent-review.md`, nhưng cấu hình ESLint hiện tại không hỗ trợ Markdown và báo lỗi parser tại ký tự `#` đầu file. Báo cáo được kiểm tra riêng bằng Markdown parser và đối chiếu số heading/finding, 59 dòng ma trận, tổng source/test; không sửa cấu hình lint để bỏ qua lỗi.
