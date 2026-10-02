import { IconBuildingBank, IconCreditCard, IconCash, IconPigMoney, IconDeviceMobile, IconWallet } from "@tabler/icons-react";

// Account icons moved from emoji to Tabler icons; new/edited accounts store
// one of ACCOUNT_ICON_KEYS. Accounts created before this change still have
// an emoji string in `icona` (e.g. "🏦") — mapped below to the same Tabler
// icon so existing data keeps rendering correctly with no server/DB
// migration. Shared by every place an account's icon is rendered (the
// account manager itself, account pickers in transactions/goals/portfolio/
// filters, and the transfer-transaction row).
const ACCOUNT_ICONS = {
  bank: IconBuildingBank,
  card: IconCreditCard,
  cash: IconCash,
  piggy: IconPigMoney,
  mobile: IconDeviceMobile,
  wallet: IconWallet,
  // legacy emoji, pre-Tabler
  "🏦": IconBuildingBank,
  "💳": IconCreditCard,
  "💵": IconCash,
  "🐖": IconPigMoney,
  "📱": IconDeviceMobile,
  "💰": IconWallet,
};
export const ACCOUNT_ICON_KEYS = ["bank", "card", "cash", "piggy", "mobile", "wallet"];

export function AccountIcon({ icona, size = 16, color, stroke = 1.8 }) {
  const Cmp = ACCOUNT_ICONS[icona] || IconBuildingBank;
  return <Cmp size={size} color={color} stroke={stroke} />;
}
