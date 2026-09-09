# Example campaign

A follow-up to people you have already spoken with — the kind of short, personal
message this tool is meant for. Copy this directory, edit the three text files,
put your SMTP settings in `.env` (start from `.env.example`), then:

```bash
bulk-email status ./campaign          # 2 pending, 1 data-error (carol has no NAME)
bulk-email preview ./campaign --to bob@example.com
bulk-email send ./campaign --dry-run
bulk-email send ./campaign
```

`${TITLE:-Mx.}` is optional (falls back when blank); `${NAME}`, `${WHEN}` and
`${TOPIC}` are strict — a blank cell blocks that row instead of sending
"Dear Mx. ,".
