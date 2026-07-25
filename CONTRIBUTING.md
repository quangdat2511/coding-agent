# Hướng dẫn đóng góp

Tài liệu này quy định quy tắc làm việc chung cho nhóm của chúng ta


## Mô hình phát triển: Trunk-Based Development (TBD)

Nhóm áp dụng **Trunk-Based Development**: thành viên làm việc trên các **short-lived branch** tách từ trunk, merge lại ngay sau khi hoàn thành.

- **Trunk** của repo là nhánh `main`.
- Trunk luôn ở trạng thái **sẵn sàng release** tại mọi thời điểm.
- Nhóm có thể **demo trực tiếp từ trunk** tại bất kỳ thời điểm nào (cuối mỗi sprint/milestone) mà không cần branch riêng để "ổn định hóa" trước demo.
- Không commit trực tiếp lên trunk (`main`).

---

## Quy tắc đặt tên branch

Branch ngắn hạn, tách từ trunk theo cấu trúc:

```
<ticket>-<mô-tả-ngắn-gọn>
```

| Thành phần | Mô tả |
|------------|-------|
| Ticket | Mã task trên board, ví dụ `CA-00`, `CA-12` |
| Mô tả ngắn gọn | Kebab-case, **viết bằng tiếng Anh**, mô tả công việc |

**Ví dụ:** `CA-00-set-up-code-base`

### Quy tắc chung

- Viết chữ thường, không dùng khoảng trắng.
- **Tên branch phải viết bằng tiếng Anh** (không dùng tiếng Việt có dấu hoặc không dấu).
- Mỗi branch gắn với **một ticket**
- Nếu một ticket có khối lượng công việc lớn, nên chủ động tách thành nhiều branch nhỏ để xử lý từng phần. Điều này giúp quá trình review code diễn ra nhanh chóng và hiệu quả hơn.
- Một branch chỉ giải quyết **một mục tiêu**.
- Branch phải **ngắn hạn** — merge vào trunk ngay khi xong, không giữ lâu.

---

## Pull Request

### Tiêu đề

```
<ticket> <type>: <mô tả ngắn gọn>
```

| Type | Ý nghĩa |
|------|---------|
| `feat` | Thêm tính năng mới |
| `fix` | Sửa lỗi |
| `docs` | Thay đổi tài liệu |
| `style` | Định dạng code (không đổi logic) |
| `refactor` | Tái cấu trúc code |
| `test` | Thêm hoặc sửa test |
| `chore` | Bảo trì, cấu hình, dependency |
| `perf` | Cải thiện hiệu năng |
| `ci` | Thay đổi CI/CD |

**Ví dụ:** `CA-00 feat: set up code base`

> **Lưu ý:** Phần `<mô tả ngắn gọn>` trong tiêu đề PR phải viết bằng **tiếng Anh**.

### Quy tắc mở Pull Request

Để đảm bảo chất lượng review và hạn chế tối đa xung đột code thì nên tách nhỏ PR nhất có thể để reviewer dễ đọc, dễ hiểu.

Reviewer chỉ bắt đầu review khi PR ở trạng thái **Ready for review** — nghĩa là chủ PR đã tự review lại toàn bộ diff của mình trước. Trong lúc chưa tự review xong, có thể để PR ở trạng thái **Draft** để tránh reviewer vào xem nhầm lúc chưa sẵn sàng.

### Quy tắc commit

- Commit message viết bằng **tiếng Anh**.
- Trên **nhánh riêng**, có thể commit bao nhiêu tùy thích.
- Khi merge vào `main`, phải **Squash and merge** — gộp nhiều commit nhỏ thành **một commit** cho thống nhất và gọn gàng.
- Commit message sau squash = tiêu đề PR 

### Điều kiện merge

- **Tất cả** thành viên cùng phụ trách task phải approve. Nếu có thành viên khác (không trực tiếp phụ trách task) chủ động yêu cầu được review, cũng phải đợi người đó approve mới được merge.
- CI pass toàn bộ. Hiện tại repo mới có check **PR title**; các check **lint, test, build** sẽ được bổ sung khi có source code.
- Nhánh phải được **đồng bộ với `main` mới nhất** trước khi merge, bằng cách **merge hoặc rebase** `main` vào nhánh (ưu tiên **rebase** để giữ lịch sử sạch trong quá trình review). Nếu phát sinh conflict, liên hệ với người có phần code conflict để cùng xử lý, hoặc tự xử lý rồi nhờ người đó review lại, để tránh làm sai logic có sẵn của người đó.

---

## Các lệnh Git thường dùng

Danh sách lệnh Git hay dùng, kèm quy trình làm việc chuẩn từ lúc nhận ticket đến khi mở PR: xem tại [`docs/git-commands.md`](docs/git-commands.md).

