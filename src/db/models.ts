import mongoose, { Schema } from "mongoose";

const opts = (collection: string, ts: boolean | object = false) => ({
  collection,
  timestamps: ts,
  toJSON: {
    virtuals: true,
    transform(_d: any, ret: any) {
      if (ret._id) ret.id = ret._id.toString();
      delete ret._id;
      delete ret.__v;
    },
  },
  toObject: {
    virtuals: true,
    transform(_d: any, ret: any) {
      if (ret._id) ret.id = ret._id.toString();
      delete ret._id;
      delete ret.__v;
    },
  },
});

// ─── User ─────────────────────────────────────────────────────────────

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true },
    name: String,
    passwordHash: String,
    googleId: String,
    stripeCustomerId: String,
    role: { type: String, default: "user" },
  },
  opts("User", true),
);
export const User = mongoose.model("User", userSchema);

// ─── Plan ─────────────────────────────────────────────────────────────

const planSchema = new Schema(
  {
    name: { type: String, required: true },
    slug: { type: String, required: true, unique: true },
    monthlyPrice: { type: Number, required: true },
    yearlyPrice: { type: Number, required: true },
    stripePriceIdMonthly: { type: String, required: true },
    stripePriceIdYearly: { type: String, required: true },
    features: [String],
    active: { type: Boolean, default: true },
  },
  opts("Plan", true),
);
export const Plan = mongoose.model("Plan", planSchema);

// ─── Subscription ─────────────────────────────────────────────────────

const subscriptionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true, unique: true },
    planId: { type: Schema.Types.ObjectId, required: true },
    stripeSubscriptionId: { type: String, required: true, unique: true },
    stripeCustomerId: { type: String, required: true },
    status: { type: String, required: true },
    interval: { type: String, required: true },
    currentPeriodStart: { type: Date, required: true },
    currentPeriodEnd: { type: Date, required: true },
    cancelAtPeriodEnd: { type: Boolean, default: false },
  },
  opts("Subscription", true),
);
export const Subscription = mongoose.model("Subscription", subscriptionSchema);

// ─── Project ──────────────────────────────────────────────────────────

const projectSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true },
    siteUrl: { type: String, required: true },
    publicKey: { type: String, required: true, unique: true },
    recordingEnabled: { type: Boolean, default: false },
    recordingSampleRate: { type: Number, default: 1.0, min: 0, max: 1 },
  },
  opts("Project", true),
);
export const Project = mongoose.model("Project", projectSchema);

// ─── ElementConfig ────────────────────────────────────────────────────

const elementConfigSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, required: true },
    label: { type: String, required: true },
    selector: { type: String, required: true },
  },
  opts("ElementConfig", true),
);
export const ElementConfig = mongoose.model("ElementConfig", elementConfigSchema);

// ─── Variant ──────────────────────────────────────────────────────────

const variantSchema = new Schema(
  {
    elementId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true },
    mutations: { type: Schema.Types.Mixed, required: true },
  },
  opts("Variant", true),
);
export const Variant = mongoose.model("Variant", variantSchema);

// ─── Rule ─────────────────────────────────────────────────────────────

const ruleSchema = new Schema(
  {
    elementId: { type: Schema.Types.ObjectId, required: true },
    description: String,
    conditions: { type: Schema.Types.Mixed, required: true },
    logic: { type: String, required: true },
    variantId: { type: Schema.Types.ObjectId, required: true },
    priority: { type: Number, required: true },
    enabled: { type: Boolean, default: true },
    startDate: Date,
    endDate: Date,
    splits: Schema.Types.Mixed,
    audienceId: Schema.Types.ObjectId,
  },
  opts("Rule", true),
);
export const Rule = mongoose.model("Rule", ruleSchema);

// ─── Audience ─────────────────────────────────────────────────────────

const audienceSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true },
    conditions: { type: Schema.Types.Mixed, required: true },
    logic: { type: String, default: "AND" },
  },
  opts("Audience", true),
);
export const Audience = mongoose.model("Audience", audienceSchema);

// ─── Event (impressions) ──────────────────────────────────────────────

const eventSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, required: true },
    elementId: { type: String, required: true },
    variantId: { type: String, required: true },
    ruleId: String,
    type: { type: String, required: true },
    visitorId: { type: String, required: true },
    url: String,
    country: String,
    countryCode: String,
    device: String,
    timestamp: { type: Date, default: Date.now },
  },
  opts("Event"),
);
eventSchema.index({ projectId: 1, timestamp: 1 });
eventSchema.index({ projectId: 1, variantId: 1 });
export const Event = mongoose.model("Event", eventSchema);

// ─── Visitor ──────────────────────────────────────────────────────────

const visitorSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, required: true },
    visitorId: { type: String, required: true },
    country: String,
    countryCode: String,
    region: String,
    city: String,
    language: String,
    device: String,
    browser: String,
    os: String,
    firstReferrer: String,
    firstUtmSource: String,
    firstUtmMedium: String,
    firstUtmCampaign: String,
    totalSessions: { type: Number, default: 0 },
    totalPageviews: { type: Number, default: 0 },
    totalEvents: { type: Number, default: 0 },
    email: String,
    name: String,
    isRandomName: { type: Boolean, default: false },
    polarCustomerId: String,
    totalRevenue: { type: Number, default: 0 },
    tags: [String],
    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
    aiSummary: String,
    aiSummaryUpdatedAt: Date,
  },
  opts("Visitor"),
);
visitorSchema.index({ projectId: 1, visitorId: 1 }, { unique: true });
visitorSchema.index({ projectId: 1, lastSeenAt: 1 });
visitorSchema.index({ projectId: 1, email: 1 });
visitorSchema.index({ projectId: 1, firstSeenAt: 1 });
export const Visitor = mongoose.model("Visitor", visitorSchema);

// ─── Session ──────────────────────────────────────────────────────────

const sessionSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, required: true },
    visitorId: { type: String, required: true },
    sessionId: { type: String, required: true },
    entryPage: String,
    exitPage: String,
    referrer: String,
    utmSource: String,
    utmMedium: String,
    utmCampaign: String,
    device: String,
    browser: String,
    os: String,
    country: String,
    countryCode: String,
    pageviews: { type: Number, default: 0 },
    events: { type: Number, default: 0 },
    duration: { type: Number, default: 0 },
    startedAt: { type: Date, default: Date.now },
    endedAt: { type: Date, default: Date.now },
  },
  opts("Session"),
);
sessionSchema.index({ projectId: 1, sessionId: 1 }, { unique: true });
sessionSchema.index({ projectId: 1, startedAt: 1 });
sessionSchema.index({ projectId: 1, visitorId: 1 });
export const Session = mongoose.model("Session", sessionSchema);

// ─── PageView ─────────────────────────────────────────────────────────

const pageViewSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, required: true },
    visitorId: { type: String, required: true },
    sessionId: { type: String, required: true },
    url: { type: String, required: true },
    title: String,
    referrer: String,
    duration: Number,
    scrollDepth: Number,
    timestamp: { type: Date, default: Date.now },
  },
  opts("PageView"),
);
pageViewSchema.index({ projectId: 1, timestamp: 1 });
pageViewSchema.index({ projectId: 1, visitorId: 1 });
pageViewSchema.index({ projectId: 1, sessionId: 1 });
export const PageView = mongoose.model("PageView", pageViewSchema);

// ─── TrackEvent ───────────────────────────────────────────────────────

const trackEventSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, required: true },
    visitorId: { type: String, required: true },
    sessionId: { type: String, required: true },
    name: { type: String, required: true },
    properties: Schema.Types.Mixed,
    url: String,
    timestamp: { type: Date, default: Date.now },
  },
  opts("TrackEvent"),
);
trackEventSchema.index({ projectId: 1, timestamp: 1 });
trackEventSchema.index({ projectId: 1, visitorId: 1 });
trackEventSchema.index({ projectId: 1, sessionId: 1 });
trackEventSchema.index({ projectId: 1, name: 1 });
export const TrackEvent = mongoose.model("TrackEvent", trackEventSchema);

// ─── Integration ──────────────────────────────────────────────────────

const integrationSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, required: true },
    type: { type: String, required: true },
    config: { type: Schema.Types.Mixed, required: true },
    enabled: { type: Boolean, default: true },
  },
  opts("Integration", true),
);
integrationSchema.index({ projectId: 1, type: 1 }, { unique: true });
export const Integration = mongoose.model("Integration", integrationSchema);

// ─── SavedSegment ─────────────────────────────────────────────────────

const savedSegmentSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true },
    naturalQuery: { type: String, required: true },
    filters: { type: Schema.Types.Mixed, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  opts("SavedSegment"),
);
savedSegmentSchema.index({ projectId: 1 });
export const SavedSegment = mongoose.model("SavedSegment", savedSegmentSchema);

// ─── SegiConversation ─────────────────────────────────────────────────

const segiConversationSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, required: true },
    title: String,
    recordingSessionId: String,
  },
  opts("SegiConversation", true),
);
segiConversationSchema.index({ projectId: 1, updatedAt: -1 });
export const SegiConversation = mongoose.model("SegiConversation", segiConversationSchema);

// ─── SegiMessage ──────────────────────────────────────────────────────

const segiMessageSchema = new Schema(
  {
    conversationId: { type: Schema.Types.ObjectId, required: true },
    role: { type: String, required: true },
    content: { type: String, default: "" },
    toolName: String,
    toolInput: Schema.Types.Mixed,
    toolOutput: Schema.Types.Mixed,
    createdAt: { type: Date, default: Date.now },
  },
  opts("SegiMessage"),
);
segiMessageSchema.index({ conversationId: 1, createdAt: 1 });
export const SegiMessage = mongoose.model("SegiMessage", segiMessageSchema);

// ─── CustomerEvent ────────────────────────────────────────────────────

const customerEventSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, required: true },
    visitorId: String,
    type: { type: String, required: true },
    amount: Number,
    currency: String,
    productName: String,
    customerEmail: String,
    externalId: String,
    provider: { type: String, required: true },
    metadata: Schema.Types.Mixed,
    timestamp: { type: Date, default: Date.now },
  },
  opts("CustomerEvent"),
);
customerEventSchema.index({ projectId: 1, timestamp: 1 });
customerEventSchema.index({ projectId: 1, visitorId: 1 });
export const CustomerEvent = mongoose.model("CustomerEvent", customerEventSchema);

// ─── Recording (session replay metadata) ─────────────────────────────

const recordingSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, required: true },
    sessionId: { type: String, required: true },
    visitorId: { type: String, required: true },
    status: { type: String, default: "recording" },
    startedAt: { type: Date, default: Date.now },
    endedAt: Date,
    duration: { type: Number, default: 0 },
    pageCount: { type: Number, default: 0 },
    clickCount: { type: Number, default: 0 },
    entryUrl: String,
    device: String,
    browser: String,
    os: String,
    country: String,
    countryCode: String,
    chunkCount: { type: Number, default: 0 },
    totalSize: { type: Number, default: 0 },
    journeySummary: String,
    journeyAnalyzedAt: Date,
  },
  opts("Recording"),
);
recordingSchema.index({ projectId: 1, sessionId: 1 }, { unique: true });
recordingSchema.index({ projectId: 1, startedAt: -1 });
recordingSchema.index(
  { startedAt: 1 },
  { expireAfterSeconds: 30 * 24 * 60 * 60 },
);
export const Recording = mongoose.model("Recording", recordingSchema);

// ─── RecordingChunk (rrweb event batches) ─────────────────────────────

const recordingChunkSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, required: true },
    sessionId: { type: String, required: true },
    seqNum: { type: Number, required: true },
    events: { type: Buffer, required: true },
    eventCount: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
  },
  opts("RecordingChunk"),
);
recordingChunkSchema.index({ projectId: 1, sessionId: 1, seqNum: 1 });
recordingChunkSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 30 * 24 * 60 * 60 },
);
export const RecordingChunk = mongoose.model("RecordingChunk", recordingChunkSchema);
