// ─── Credentials ───────────────────────────────────────────

export interface Credentials {
  botToken: string;
  baseUrl: string;
  ilinkBotId: string;
  ilinkUserId: string;
}

// ─── Media ─────────────────────────────────────────────────

export interface CDNMedia {
  encrypt_query_param: string;
  aes_key: string;
  encrypt_type?: number;
  full_url?: string;
}

// ─── Message Items ─────────────────────────────────────────

export interface TextItem {
  text: string;
}

export interface ImageItem {
  media: CDNMedia;
  aeskey?: string;
  url?: string;
  mid_size?: number;
  thumb_height?: number;
  thumb_width?: number;
  hd_size?: number;
}

export interface VoiceItem {
  media: CDNMedia;
  encode_type?: number;
  text?: string;
  playtime?: number;
}

export interface FileItem {
  media: CDNMedia;
  file_name?: string;
  md5?: string;
  len?: string;
}

export interface VideoItem {
  media: CDNMedia;
  video_size?: number;
  play_length?: number;
  thumb_media?: CDNMedia;
}

export interface RefMsg {
  title?: string;
  message_item?: MessageItem;
}

export interface MessageItem {
  type: 1 | 2 | 3 | 4 | 5;
  create_time_ms?: number;
  update_time_ms?: number;
  is_completed?: boolean;
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  file_item?: FileItem;
  video_item?: VideoItem;
  ref_msg?: RefMsg;
}

// ─── Messages ──────────────────────────────────────────────

export interface WeixinMessage {
  message_id: number;
  from_user_id: string;
  to_user_id: string;
  client_id: string;
  create_time_ms: number;
  message_type: number;   // 1 = USER, 2 = BOT
  message_state: number;  // 0 = NEW, 1 = GENERATING, 2 = FINISH
  context_token: string;
  item_list: MessageItem[];
}

// ─── API Responses ─────────────────────────────────────────

export interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

export interface QRCodeStatusResponse {
  status: 'wait' | 'scaned' | 'confirmed' | 'expired';
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
}

export interface GetUpdatesResponse {
  ret: number;
  msgs: WeixinMessage[];
  get_updates_buf: string;
  longpolling_timeout_ms: number;
  errcode: number;
  errmsg: string;
}

export interface SendMessageResponse {
  ret: number;
  errcode: number;
  errmsg: string;
}

export interface GetConfigResponse {
  typing_ticket: string;
  ret: number;
}
