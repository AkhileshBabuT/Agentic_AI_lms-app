CREATE TABLE IF NOT EXISTS chat_stream_requests (
  session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_key VARCHAR(128) NOT NULL,
  question_hash CHAR(64) NOT NULL,
  student_message_id INTEGER REFERENCES chat_messages(id) ON DELETE SET NULL,
  agent_message_id INTEGER REFERENCES chat_messages(id) ON DELETE SET NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','failed','complete')),
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (session_id,user_id,request_key)
);
