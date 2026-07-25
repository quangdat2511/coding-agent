# Coding Agent

> Coding Agent — hệ thống AI agent tiếp nhận yêu cầu bằng ngôn ngữ tự nhiên và tự động thực hiện các tác vụ lập trình đa năng (sinh code, sửa lỗi, hỗ trợ review) dựa trên ngữ cảnh codebase thực tế.

Đồ án tốt nghiệp — Khoa Công nghệ Thông tin, Trường Đại học Khoa Học Tự Nhiên, Đại học Quốc gia TP.HCM. Chuyên ngành **Kỹ thuật phần mềm**.

## Mục lục

- [Giới thiệu](#giới-thiệu)
- [Tính năng chính](#tính-năng-chính)
- [Công nghệ sử dụng](#công-nghệ-sử-dụng)
- [Thông tin dự án](#thông-tin-dự-án)

---

## Giới thiệu

Trong bối cảnh AI đang trở thành một phần không thể thiếu của phát triển phần mềm hiện đại, xu hướng đang dịch chuyển từ autocomplete đơn giản sang **agentic workflow** — AI tự lập kế hoạch, gọi tool, chạy test và xử lý lỗi qua nhiều bước thay vì chỉ gợi ý code.

**Coding Agent** là một Coding Agent được xây dựng với kiến trúc có kiểm soát, gồm các thành phần cốt lõi: Agent Runtime, Context Intelligence, Planning, Verification, Safety và Memory. Mục tiêu là chứng minh tính khả thi của kiến trúc agent này trên các tác vụ lập trình thực tế, đo lường qua benchmark nội bộ (đối chiếu với **TerminalBench**, cùng điều kiện với Pi), đồng thời đảm bảo các cơ chế an toàn khi agent được trao quyền thao tác lên mã nguồn.

Hệ thống được thiết kế **language-agnostic** — dựa trên khả năng hiểu code của LLM nền tảng, không phụ thuộc parser riêng cho từng ngôn ngữ lập trình.

## Tính năng chính

- **Sinh code mới** dựa trên yêu cầu ngôn ngữ tự nhiên và ngữ cảnh codebase hiện có
- **Sửa lỗi (bug fix)** tự động, có xác minh lại kết quả qua test/lint
- **Hỗ trợ review code**
- **Context Intelligence** — truy xuất ngữ cảnh codebase qua retrieval, embedding, semantic search
- **Planning** — chia nhỏ task phức tạp thành các bước thực thi
- **Verification** — tự động chạy test, lint, validate output trước khi hoàn tất
- **Safety** — sandbox hóa môi trường thực thi, giới hạn phạm vi hành động, rate limit
- **Memory** — lưu trạng thái và lịch sử thao tác xuyên suốt một task/session
- Tương tác qua **CLI** (dòng lệnh), phục vụ luồng làm việc kỹ thuật chính

## Công nghệ sử dụng

| Thành phần | Công nghệ |
|------------|-----------|
| Ngôn ngữ / Runtime | TypeScript, Bun |
| Lưu trữ session/config | SQLite + Drizzle ORM |
| Vector DB (Context Intelligence) | Đang khảo sát: Chroma / Pinecone / Qdrant |
| Agent orchestration | Đang khảo sát: LangGraph hoặc custom orchestration |
| Sandbox thực thi | Git worktree + process wrapper / Docker |
| LLM providers | Claude, GPT, Gemini, DeepSeek, OpenRouter (qua API); Ollama/LM Studio (local) |
| Tích hợp | MCP (Model Context Protocol), LSP (Language Server Protocol) |
| Project management | Jira |

## Thông tin dự án

**Giảng viên hướng dẫn:** Ngô Ngọc Đăng Khoa

**Nhóm thực hiện:**

| MSSV | Họ và tên |
|------|-----------|
| 23127038 | Lê Võ Phú Danh |
| 23127046 | Tôn Thất Hoàn |
| 23127059 | Hồ Văn Khải |
| 23127166 | Nguyễn Hoàng Đăng  |
| 23127341 | Ngô Trần Quang Đạt|
| 23127378 | Nguyễn Gia Huy |





