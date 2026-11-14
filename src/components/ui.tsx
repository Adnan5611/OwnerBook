import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export const colors = {
  background: '#F3F6F4',
  ink: '#172E29',
  muted: '#586B64',
  green: '#17664E',
  border: '#DCE5DF',
  white: '#FFFFFF',
  red: '#A33332',
  amber: '#855514',
};
export function Screen({
  children,
  title,
  subtitle,
}: {
  children: ReactNode;
  title: string;
  subtitle?: string;
}) {
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.content}>
          <Text accessibilityRole="header" style={styles.title}>
            {title}
          </Text>
          {subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
          {children}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
export function Card({ children }: { children: ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}
export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor="#73847D"
        autoCapitalize="none"
        style={styles.input}
        {...props}
      />
    </View>
  );
}
export function Button({
  title,
  onPress,
  disabled,
  busy,
  secondary,
  danger,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  secondary?: boolean;
  danger?: boolean;
}) {
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        secondary && styles.secondary,
        danger && styles.danger,
        off && styles.disabled,
        pressed && !off && styles.pressed,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={secondary ? colors.green : colors.white} />
      ) : (
        <Text
          style={[
            styles.buttonText,
            secondary && styles.secondaryText,
            danger && styles.dangerText,
          ]}
        >
          {title}
        </Text>
      )}
    </Pressable>
  );
}
export function Notice({ children, error }: { children: ReactNode; error?: boolean }) {
  return (
    <View accessibilityLiveRegion="polite" style={[styles.notice, error && styles.errorNotice]}>
      <Text style={[styles.noticeText, error && styles.errorText]}>{children}</Text>
    </View>
  );
}
export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <View accessibilityLiveRegion="polite" style={styles.loading}>
      <ActivityIndicator color={colors.green} />
      <Text style={styles.subtitle}>{label}</Text>
    </View>
  );
}
export function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.muted}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}
export function EmptyState({
  title,
  message,
  action,
}: {
  title: string;
  message: string;
  action?: ReactNode;
}) {
  return (
    <Card>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.subtitle}>{message}</Text>
      {action}
    </Card>
  );
}
/** Pressable list row used by the khata, transaction and catalog lists. */
export function ListItem({
  title,
  subtitle,
  right,
  rightLabel,
  onPress,
  disabled,
  muted,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  rightLabel?: string;
  onPress?: () => void;
  disabled?: boolean;
  muted?: boolean;
}) {
  const content = (
    <>
      <View style={styles.listText}>
        <Text numberOfLines={2} style={[styles.listTitle, muted && styles.listTitleMuted]}>
          {title}
        </Text>
        {subtitle ? (
          <Text numberOfLines={2} style={styles.listSubtitle}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right ?? (rightLabel ? <Text style={styles.listRight}>{rightLabel}</Text> : null)}
    </>
  );
  if (!onPress) return <View style={styles.listItem}>{content}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={rightLabel ? `${title}, ${rightLabel}` : title}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.listItem,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      {content}
    </Pressable>
  );
}
/** Segmented control for the Transactions tab and list filters. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <View style={styles.segmented} accessibilityRole="tablist">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => onChange(option.value)}
            style={[styles.segment, selected && styles.segmentSelected]}
          >
            <Text style={[styles.segmentText, selected && styles.segmentTextSelected]}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
/** Selectable option row used for payment methods and pickers. */
export function Choice({
  label,
  hint,
  selected,
  onPress,
}: {
  label: string;
  hint?: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected, checked: selected }}
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.choice, selected && styles.choiceSelected]}
    >
      <View style={styles.listText}>
        <Text style={[styles.choiceLabel, selected && styles.choiceLabelSelected]}>{label}</Text>
        {hint ? <Text style={styles.listSubtitle}>{hint}</Text> : null}
      </View>
      <Text style={[styles.radio, selected && styles.radioSelected]}>{selected ? '●' : '○'}</Text>
    </Pressable>
  );
}
export function Tag({
  label,
  tone = 'neutral',
}: {
  label: string;
  tone?: 'neutral' | 'good' | 'bad';
}) {
  return (
    <View style={[styles.tag, tone === 'good' && styles.tagGood, tone === 'bad' && styles.tagBad]}>
      <Text
        style={[
          styles.tagText,
          tone === 'good' && styles.tagTextGood,
          tone === 'bad' && styles.tagTextBad,
        ]}
      >
        {label}
      </Text>
    </View>
  );
}
/** Label/amount pair used for totals; the amount is always an exact decimal string. */
export function AmountRow({
  label,
  amount,
  emphasis,
  tone,
}: {
  label: string;
  amount: string;
  emphasis?: boolean;
  tone?: 'good' | 'bad';
}) {
  return (
    <View style={styles.amountRow}>
      <Text style={[styles.muted, emphasis && styles.amountLabelStrong]}>{label}</Text>
      <Text
        style={[
          styles.amountValue,
          emphasis && styles.amountValueStrong,
          tone === 'good' && styles.amountGood,
          tone === 'bad' && styles.amountBad,
        ]}
      >
        {amount}
      </Text>
    </View>
  );
}
export function SectionTitle({ children }: { children: ReactNode }) {
  return <Text style={styles.sectionTitle}>{children}</Text>;
}
export function Money({
  amount,
  currency,
  size = 'normal',
  tone,
}: {
  amount: string;
  currency?: string | null;
  size?: 'normal' | 'large';
  tone?: 'good' | 'bad';
}) {
  return (
    <Text
      style={[
        size === 'large' ? styles.moneyLarge : styles.money,
        tone === 'good' && styles.amountGood,
        tone === 'bad' && styles.amountBad,
      ]}
    >
      {currency ? `${currency} ${amount}` : amount}
    </Text>
  );
}
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  scroll: { padding: 20, paddingBottom: 32 },
  content: { width: '100%', maxWidth: 640, alignSelf: 'center', gap: 16 },
  title: {
    fontSize: 30,
    lineHeight: 37,
    fontWeight: '700',
    color: colors.ink,
    letterSpacing: -0.8,
  },
  subtitle: { fontSize: 15, lineHeight: 23, color: colors.muted },
  card: {
    padding: 20,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.white,
    gap: 14,
  },
  field: { gap: 7 },
  label: { fontSize: 14, fontWeight: '600', color: colors.ink },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.white,
    borderRadius: 10,
    padding: 13,
    minHeight: 48,
    fontSize: 16,
    color: colors.ink,
  },
  button: {
    minHeight: 48,
    padding: 13,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.green,
  },
  buttonText: { color: colors.white, fontSize: 15, fontWeight: '700', textAlign: 'center' },
  secondary: { backgroundColor: '#E6EDE8' },
  secondaryText: { color: colors.green },
  danger: { backgroundColor: '#F9E9E7' },
  dangerText: { color: colors.red },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.75 },
  notice: { backgroundColor: '#E6EDE8', borderRadius: 10, padding: 13 },
  noticeText: { color: colors.ink, fontSize: 14, lineHeight: 21 },
  errorNotice: { backgroundColor: '#F9E9E7' },
  errorText: { color: colors.red },
  loading: { minHeight: 160, alignItems: 'center', justifyContent: 'center', gap: 15 },
  row: { gap: 4, paddingVertical: 6 },
  muted: { color: colors.muted, fontSize: 13 },
  value: { color: colors.ink, fontSize: 16, fontWeight: '600', flexShrink: 1 },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: colors.ink },
  listItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 13,
    paddingHorizontal: 16,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.white,
  },
  listText: { flex: 1, gap: 3 },
  listTitle: { fontSize: 16, fontWeight: '600', color: colors.ink },
  listTitleMuted: { color: colors.muted },
  listSubtitle: { fontSize: 13, color: colors.muted, lineHeight: 18 },
  listRight: { fontSize: 15, fontWeight: '700', color: colors.ink, textAlign: 'right' },
  segmented: {
    flexDirection: 'row',
    gap: 6,
    backgroundColor: '#E6EDE8',
    padding: 4,
    borderRadius: 12,
  },
  segment: { flex: 1, paddingVertical: 9, borderRadius: 9, alignItems: 'center' },
  segmentSelected: { backgroundColor: colors.white },
  segmentText: { fontSize: 13, fontWeight: '600', color: colors.muted },
  segmentTextSelected: { color: colors.green },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 11,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.white,
  },
  choiceSelected: { borderColor: colors.green, backgroundColor: '#EEF5F1' },
  choiceLabel: { fontSize: 15, fontWeight: '600', color: colors.ink },
  choiceLabelSelected: { color: colors.green },
  radio: { fontSize: 16, color: colors.border },
  radioSelected: { color: colors.green },
  tag: {
    alignSelf: 'flex-start',
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: '#E6EDE8',
  },
  tagGood: { backgroundColor: '#DDEDE4' },
  tagBad: { backgroundColor: '#F6DFDC' },
  tagText: { fontSize: 11, fontWeight: '700', color: colors.muted, letterSpacing: 0.4 },
  tagTextGood: { color: colors.green },
  tagTextBad: { color: colors.red },
  amountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 5,
  },
  amountLabelStrong: { color: colors.ink, fontWeight: '700', fontSize: 14 },
  amountValue: { fontSize: 15, fontWeight: '600', color: colors.ink },
  amountValueStrong: { fontSize: 18, fontWeight: '700' },
  amountGood: { color: colors.green },
  amountBad: { color: colors.red },
  sectionTitle: {
    fontSize: 12,
    letterSpacing: 1.2,
    fontWeight: '700',
    color: colors.muted,
    textTransform: 'uppercase',
  },
  money: { fontSize: 16, fontWeight: '700', color: colors.ink },
  moneyLarge: { fontSize: 26, fontWeight: '700', color: colors.ink, letterSpacing: -0.6 },
});
