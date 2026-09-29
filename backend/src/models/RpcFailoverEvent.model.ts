import mongoose, { Schema, Document } from 'mongoose';

/**
 * RPC Failover Event
 * Audit record written whenever a Soroban RPC call fails over from one
 * endpoint to another (or exhausts every endpoint). Endpoints are stored
 * redacted (origin only). Records expire automatically after 30 days.
 */
export interface IRpcFailoverEvent extends Document {
  operation: string;
  fromEndpoint: string;
  toEndpoint?: string;
  reason: string;
  errorCode?: string;
  circuitOpened: boolean;
  occurredAt: Date;
}

const THIRTY_DAYS_IN_SECONDS = 30 * 24 * 60 * 60;

const RpcFailoverEventSchema: Schema = new Schema({
  operation: {
    type: String,
    required: true,
  },
  fromEndpoint: {
    type: String,
    required: true,
    index: true,
  },
  toEndpoint: {
    type: String,
  },
  reason: {
    type: String,
    required: true,
    maxlength: 1000,
  },
  errorCode: {
    type: String,
  },
  circuitOpened: {
    type: Boolean,
    default: false,
  },
  occurredAt: {
    type: Date,
    default: Date.now,
    required: true,
    expires: THIRTY_DAYS_IN_SECONDS,
  },
});

export default mongoose.model<IRpcFailoverEvent>('RpcFailoverEvent', RpcFailoverEventSchema);
