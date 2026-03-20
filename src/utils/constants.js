const ROLE_VALUES = ['carry', 'mid', 'offlane', 'support'];

const ROLE_LABELS = {
  carry: 'Carry',
  mid: 'Mid',
  offlane: 'Offlane',
  support: 'Support',
};

const TEAM_LABELS = {
  radiant: 'Radiant',
  dire: 'Dire',
};

const EMBED_COLORS = {
  primary: 0x2f80ed,
  neutral: 0x6b7280,
  success: 0x00ff00,
  warning: 0xffaa00,
  danger: 0xff3b30,
  error: 0xff0000,
  info: 0x0099ff,
};

const MATCH_STATUS = {
  OPEN: 'OPEN',
  READY_CHECK: 'READY_CHECK',
  REPORTED: 'REPORTED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
};

const READY_STATUS = {
  READY: 'READY',
  NOT_READY: 'NOT_READY',
  NO_RESPONSE: 'NO_RESPONSE',
  DECLINED: 'DECLINED',
  TIMEOUT: 'TIMEOUT',
  REQUEUED: 'REQUEUED',
};

const BUTTON_IDS = {
  QUEUE_JOIN: 'queue:join',
  QUEUE_LEAVE: 'queue:leave',
  QUEUE_REFRESH: 'queue:refresh',
  READY_PREFIX: 'ready',
};

module.exports = {
  BUTTON_IDS,
  ROLE_VALUES,
  ROLE_LABELS,
  TEAM_LABELS,
  EMBED_COLORS,
  MATCH_STATUS,
  READY_STATUS,
};
