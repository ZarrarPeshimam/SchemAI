import mongoose from 'mongoose';

const { Schema, model } = mongoose;

// Message subdocument schema
const MessageSchema = new Schema(
  {
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true },
    operation: { type: String }, // e.g., generate, refine, clarification, error
    schemaVersion: { type: Number },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

// Conversation document schema
const ConversationSchema = new Schema(
  {
    title: { type: String, required: true },
    schema: { type: Schema.Types.Mixed }, // stored accepted schema JSON
    schemaVersion: { type: Number, default: 1 },
    messages: [MessageSchema],
  },
  { timestamps: true }
);

export const Conversation = model('Conversation', ConversationSchema);
