# Build Guide Workflow operations

Tài liệu này mô tả quy trình staging/cutover/rollback dự kiến. Chưa thực hiện các bước vận hành này.

## Prerequisites

- Dùng các package cùng một bản tương thích: `plugin-build-guide-block@1.1.14` và `plugin-workflow-build-guide@0.1.0`.
- Bật sẵn các plugin AI, Workflow và Workflow Loop mà graph cần. Adapter phụ thuộc vào Build Guide, AI, Workflow và Loop; không cài adapter trước plugin phụ thuộc.
- Xác nhận mọi HTTP và Workflow worker instance chạy cùng bản code. Nếu triển khai tách worker `workflow:process`, kiểm chứng role/queue đó riêng trong staging; validation receipt hiện chỉ xác nhận worker trong tiến trình `getApp`.
- Sao lưu database và tệp đính kèm trước upgrade. Các collection/field mới đồng bộ qua quy trình `yarn nocobase upgrade` của môi trường; chưa chạy lệnh này trong công việc hiện tại.

## Staging setup and pilot

1. Cài hai package vào staging nhưng giữ Build Guide engine ở `legacy`; cài và enable theo dependency, sau đó chạy quy trình upgrade của staging.
2. Với quyền root, gọi resource action `workflowBuildGuide:setup`. Chỉ tiếp tục khi kết quả báo `enabled: true`, không có `blockers`, và revision hiện hành là graph do adapter quản lý.
3. Kiểm tra provider/model trong AI. Tạo một Space thử nghiệm, chọn engine `workflow`, cấu hình nguồn/chương và chạy Build. Chuyển đổi engine chỉ áp dụng cho run mới.
4. Theo dõi status endpoint/UI: `queued`, `running`, `completed`, `failed`, `cancelled` hoặc `unknown`; kiểm tra execution/job bằng quyền tương ứng. Chỉ dựa vào `canCancel`/`canRetry` trả về từ server để bật thao tác.
5. Xác nhận published guide vẫn đọc được khi rebuild thất bại và sau khi run mới hoàn tất. Kiểm tra HTML/Markdown, User Guide block, picker v1/v2 và `search-guides` trong staging.
6. Không tạo revision managed mới khi run revision cũ còn hoạt động. Drain run trước khi provision lại, vì native Workflow có thể disable revision cũ cùng key.

`failed` và `cancelled` mới đủ điều kiện retry theo capability của server. Không retry mù một run `unknown`: xác minh trạng thái provider/Workflow trước; nếu cần dừng, chỉ dùng cancel khi server báo `canCancel`.

## Cutover

1. Chỉ cutover sau khi staging đã xác nhận HTTP và worker thực tế, quyền, provider, recovery và lịch backup.
2. Tạm dừng nhận build mới; để run legacy đang hoạt động hoàn tất hoặc chấm dứt theo quy trình vận hành. Không gửi cùng một run cho cả legacy và Workflow.
3. Xác nhận toàn bộ HTTP và worker instance hỗ trợ trường engine/run ownership và cùng workflow revision. Giữ adapter/Workflow khả dụng trong thời gian có run workflow.
4. Chuyển engine cho pilot Space sang `workflow`, mở nhận build mới có kiểm soát, rồi theo dõi execution, checkpoint, lỗi an toàn và nội dung published.
5. Mở rộng từng nhóm Space sau khi pilot ổn định; giữ legacy worker trong giai đoạn theo dõi nhưng chỉ cho phép claim run có `engine=legacy`.

## Rollback

1. Dừng nhận run workflow mới. Chờ run đang hoạt động hoàn tất hoặc hủy/invalidate bằng thao tác được server cho phép; không đổi owner của run sang legacy.
2. Giữ adapter và Workflow plugin bật đến khi không còn run workflow hoạt động hoặc đang cần reconcile. Không disable workflow revision đang xử lý run.
3. Chuyển engine sang `legacy` cho các run mới. Published HTML/Markdown, page và run/checkpoint cũ phải được giữ nguyên.
4. Không drop collection, xóa artifacts/checkpoints hoặc downgrade schema trong rollback. Sau khi run workflow đã được xử lý và dữ liệu đã kiểm chứng, việc gỡ package là thay đổi vận hành riêng.

Nếu trạng thái run là `unknown`, giữ dữ liệu và đối soát execution/job/provider trước khi retry hoặc tiếp tục cutover. Không coi `unknown` là thành công.
