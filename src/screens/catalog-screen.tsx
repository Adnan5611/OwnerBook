import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import type { OwnerBookClient } from '../lib/supabase';
import { useWorkspace } from '../providers/workspace-provider';
import {
  AmountRow,
  Button,
  Card,
  EmptyState,
  Field,
  ListItem,
  Loading,
  Notice,
  Screen,
  SectionTitle,
  Tag,
  colors,
} from '../components/ui';
import { OfflineBanner } from '../components/OfflineBanner';
import { listProducts, saveProduct } from '../lib/sales-service';
import { capabilitiesFor } from '../lib/permissions';
import { safeErrorMessage } from '../lib/errors';
import { formatMoney, parseStoredAmount } from '../lib/decimal';
import type { ProductRow } from '../types/database';

type Props = { client: OwnerBookClient };

/**
 * The Phase 3 catalog holds name, SKU, unit and two prices. It is already
 * barcode-ready (SKU is a unique text key) but stock quantities, movements and
 * valuation arrive in Phase 4 with suppliers and purchases.
 */
export function CatalogScreen({
  client,
  onNewProduct,
  onEditProduct,
}: Props & { onNewProduct: () => void; onEditProduct: (productId: string) => void }) {
  const workspace = useWorkspace();
  const business = workspace.active?.business;
  const currency = business?.currency ?? '';
  const capabilities = capabilitiesFor(workspace.active?.membership.role);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (!business) return;
    setLoading(true);
    setError(null);
    try {
      setProducts(
        await listProducts(client, business.id, {
          search: query,
          includeArchived: showArchived,
          limit: 200,
        }),
      );
    } catch (cause) {
      setError(safeErrorMessage(cause, 'Could not load the catalog.'));
    } finally {
      setLoading(false);
    }
  }, [business, client, query, showArchived]);
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void Promise.resolve().then(() => {
        if (!cancelled) return refresh();
      });
      return () => {
        cancelled = true;
      };
    }, [refresh]),
  );
  return (
    <Screen
      title="Items"
      subtitle={business ? `Catalog for ${business.name}` : 'Select a business'}
    >
      <OfflineBanner />
      {!!error && <Notice error>{error}</Notice>}
      <Card>
        <Field
          label="Search items"
          value={search}
          onChangeText={setSearch}
          placeholder="Name or SKU"
          returnKeyType="search"
          onSubmitEditing={() => setQuery(search.trim())}
        />
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button title="Search" secondary onPress={() => setQuery(search.trim())} />
          <Button
            title={showArchived ? 'Hide archived' : 'Show archived'}
            secondary
            onPress={() => setShowArchived((value) => !value)}
          />
        </View>
      </Card>
      {capabilities.canManageCatalog && !business?.archived_at && (
        <Button title="Add item" onPress={onNewProduct} />
      )}
      {loading && products.length === 0 ? <Loading label="Loading the catalog…" /> : null}
      {!loading && products.length === 0 ? (
        <EmptyState
          title={query ? 'No item matches that search' : 'The catalog is empty'}
          message="Add items to sell them with one tap and to keep a cost on every line, so gross profit is real instead of assumed. You can also sell a custom item without adding it here."
        />
      ) : null}
      {products.map((product) => (
        <View key={product.id} style={{ gap: 6 }}>
          <ListItem
            title={product.name}
            subtitle={[
              product.sku ? `SKU ${product.sku}` : 'No SKU',
              `per ${product.unit}`,
              product.cost_price && parseStoredAmount(product.cost_price) > 0n
                ? `cost ${formatMoney(product.cost_price, currency)}`
                : 'no cost recorded',
            ].join(' · ')}
            rightLabel={formatMoney(product.sale_price, currency)}
            muted={!!product.archived_at}
            onPress={capabilities.canManageCatalog ? () => onEditProduct(product.id) : undefined}
          />
          {product.archived_at ? <Tag label="ARCHIVED" tone="bad" /> : null}
        </View>
      ))}
      <Button title="Refresh" secondary busy={loading} onPress={() => void refresh()} />
      <Text style={{ color: colors.muted, fontSize: 12, lineHeight: 18 }}>
        A sale copies the name, price and cost of the item at that moment. Changing a price here
        never rewrites a saved sale, so history stays auditable. Stock levels and valuation arrive
        in Phase 4.
      </Text>
    </Screen>
  );
}

export function ProductFormScreen({
  client,
  productId,
  onDone,
}: Props & { productId?: string | null; onDone: (message: string) => void }) {
  const workspace = useWorkspace();
  const business = workspace.active?.business;
  const scale =
    workspace.currencies.find((item) => item.code === business?.currency)?.minor_units ?? 2;
  const currency = business?.currency ?? '';
  const [name, setName] = useState('');
  const [sku, setSku] = useState('');
  const [unit, setUnit] = useState('pcs');
  const [salePrice, setSalePrice] = useState('');
  const [costPrice, setCostPrice] = useState('');
  const [loading, setLoading] = useState(!!productId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!business || !productId) return;
    setLoading(true);
    try {
      const rows = await listProducts(client, business.id, { includeArchived: true, limit: 200 });
      const found = rows.find((row) => row.id === productId);
      if (found) {
        setName(found.name);
        setSku(found.sku ?? '');
        setUnit(found.unit);
        setSalePrice(found.sale_price);
        setCostPrice(found.cost_price);
      }
    } catch (cause) {
      setError(safeErrorMessage(cause, 'Could not load this item.'));
    } finally {
      setLoading(false);
    }
  }, [business, client, productId]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  if (!business)
    return (
      <Screen title="Item" subtitle="Select a business first">
        <Notice error>No business is selected. Choose one in Settings first.</Notice>
      </Screen>
    );
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await saveProduct(client, {
        businessId: business.id,
        productId: productId ?? null,
        name,
        sku,
        unit,
        salePrice,
        costPrice,
        scale,
      });
      onDone(
        `${result.created ? 'Added' : 'Updated'} ${result.name} at ${formatMoney(result.sale_price, result.currency)} per unit.`,
      );
    } catch (cause) {
      setError(safeErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  if (loading) return <Loading label="Loading item…" />;
  return (
    <Screen
      title={productId ? 'Edit item' : 'New item'}
      subtitle={productId ? 'Price changes apply to future sales only' : 'Add it to the catalog'}
    >
      <OfflineBanner />
      {!!error && <Notice error>{error}</Notice>}
      <Card>
        <Field label="Name" value={name} onChangeText={setName} placeholder="Basmati rice 5 kg" />
        <Field
          label="SKU or barcode (optional)"
          value={sku}
          onChangeText={setSku}
          placeholder="RICE-5KG"
        />
        <Field label="Unit" value={unit} onChangeText={setUnit} placeholder="bag" />
        <Field
          label={`Sale price (${currency})`}
          value={salePrice}
          onChangeText={setSalePrice}
          keyboardType="decimal-pad"
          placeholder="0"
        />
        <Field
          label={`Cost price (${currency}, optional)`}
          value={costPrice}
          onChangeText={setCostPrice}
          keyboardType="decimal-pad"
          placeholder="0"
        />
      </Card>
      <Card>
        <SectionTitle>What a cost does</SectionTitle>
        <AmountRow label="Currency scale" amount={`${scale} decimals`} />
        <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 19 }}>
          The cost price is copied onto every sale line, which is how cost of goods sold and gross
          profit are calculated. Without a cost, the item still sells but the period report shows
          that revenue as uncovered cost. Phase 4 replaces this manual cost with a weighted-average
          cost from real stock movements.
        </Text>
      </Card>
      <Button
        title={productId ? 'Save item' : 'Add item'}
        busy={busy}
        disabled={!!business.archived_at}
        onPress={() => void submit()}
      />
      <Text style={{ color: colors.muted, fontSize: 12, lineHeight: 18 }}>
        The item is saved on the server with a unique operation id, so a retry after a dropped
        connection cannot create it twice.
      </Text>
    </Screen>
  );
}
