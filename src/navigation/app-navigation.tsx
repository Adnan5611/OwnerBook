import { createContext, useContext, useEffect, useState } from 'react';
import { Text } from 'react-native';
import {
  NavigationContainer,
  useNavigation,
  type NavigationProp,
  createNavigationContainerRef,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { OwnerBookClient } from '../lib/supabase';
import { useAuth } from '../providers/auth-provider';
import { WorkspaceProvider, useWorkspace } from '../providers/workspace-provider';
import { AuthScreen } from '../screens/auth-screen';
import {
  BusinessForm,
  BusinessPicker,
  CreateInvitationScreen,
  InvitationScreen,
} from '../screens/business-screens';
import { InvitationsScreen, MemberScreen } from '../screens/member-screen';
import { SettingsScreen } from '../screens/settings-screen';
import { HomeScreen } from '../screens/home-screen';
import {
  AdjustmentFormScreen,
  CustomerDetailScreen,
  CustomerFormScreen,
  KhataTab,
  PaymentFormScreen,
} from '../screens/khata-screens';
import {
  ExpenseFormScreen,
  SaleDetailScreen,
  SaleFormScreen,
  TransactionsTab,
} from '../screens/transaction-screens';
import { CatalogScreen, ProductFormScreen } from '../screens/catalog-screen';
import { Card, Loading, Screen, colors } from '../components/ui';
import { FlashProvider, useFlash } from '../components/flash';

type Routes = {
  Tabs: undefined;
  Businesses: undefined;
  CreateBusiness: undefined;
  BusinessSettings: undefined;
  Members: undefined;
  Invitations: undefined;
  CreateInvitation: undefined;
  JoinBusiness: { token?: string } | undefined;
  CustomerDetail: { customerId: string };
  CustomerForm: { customerId?: string | null };
  PaymentForm: { customerId: string };
  AdjustmentForm: { customerId: string };
  SaleForm: { customerId?: string | null };
  SaleDetail: { saleId: string };
  ExpenseForm: undefined;
  Catalog: undefined;
  ProductForm: { productId?: string | null };
};
type TabRoutes = {
  Home: undefined;
  Khata: undefined;
  Transactions: undefined;
  Chat: undefined;
  Settings: undefined;
};
const Stack = createNativeStackNavigator<Routes>();
const Tabs = createBottomTabNavigator<TabRoutes>();
const navigationRef = createNavigationContainerRef<Routes>();
const ClientContext = createContext<OwnerBookClient | null>(null);
/**
 * The Businesses route is only mounted while no business is active or the picker
 * is explicitly open, so "switch business" cannot be a plain navigate: it has to
 * ask the workspace to show the picker. This context is that request channel.
 */
const WorkspaceActionsContext = createContext<{
  openBusinessPicker: () => void;
  joinBusiness: (token?: string) => void;
}>({ openBusinessPicker: () => undefined, joinBusiness: () => undefined });

function useClient(): OwnerBookClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error('The Supabase client is not available yet.');
  return client;
}

function useWorkspaceActions() {
  return useContext(WorkspaceActionsContext);
}

function Unavailable({ module, phase }: { module: string; phase: string }) {
  return (
    <Screen title={module} subtitle="Not enabled yet">
      <Card>
        <Text style={{ color: colors.ink, fontSize: 18, fontWeight: '700' }}>No demo data</Text>
        <Text style={{ color: colors.muted, lineHeight: 23 }}>
          {module} will be implemented in {phase}, with persistent records, database permissions,
          accounting checks and tests. There are no fabricated transactions or balances here.
        </Text>
      </Card>
    </Screen>
  );
}

function HomeTab() {
  const client = useClient();
  const tabs = useNavigation<NavigationProp<TabRoutes>>();
  const { openBusinessPicker, joinBusiness } = useWorkspaceActions();
  return (
    <HomeScreen
      client={client}
      actions={{
        onNewSale: () => navigationRef.navigate('SaleForm', {}),
        onCatalog: () => navigationRef.navigate('Catalog'),
        onKhata: () => tabs.navigate('Khata'),
        onMembers: () => navigationRef.navigate('Members'),
        onBusinesses: openBusinessPicker,
        onJoinBusiness: () => joinBusiness(),
        onOpenSale: (saleId) => navigationRef.navigate('SaleDetail', { saleId }),
      }}
    />
  );
}

function KhataTabScreen() {
  const client = useClient();
  return (
    <KhataTab
      client={client}
      onOpenCustomer={(customerId) => navigationRef.navigate('CustomerDetail', { customerId })}
      onNewCustomer={() => navigationRef.navigate('CustomerForm', {})}
    />
  );
}

function TransactionsTabScreen() {
  const client = useClient();
  return (
    <TransactionsTab
      client={client}
      onNewSale={() => navigationRef.navigate('SaleForm', {})}
      onNewExpense={() => navigationRef.navigate('ExpenseForm')}
      onOpenSale={(saleId) => navigationRef.navigate('SaleDetail', { saleId })}
    />
  );
}

function ChatPlaceholder() {
  return <Unavailable module="Business chat" phase="Phase 6" />;
}

function SettingsTab() {
  const client = useClient();
  const { openBusinessPicker } = useWorkspaceActions();
  return (
    <SettingsScreen
      client={client}
      onBusinesses={openBusinessPicker}
      onMembers={() => navigationRef.navigate('Members')}
      onSettings={() => navigationRef.navigate('BusinessSettings')}
    />
  );
}

function MainTabs() {
  const insets = useSafeAreaInsets();
  return (
    <Tabs.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.green,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: {
          minHeight: 58,
          paddingBottom: Math.max(insets.bottom, 6),
          paddingTop: 6,
          backgroundColor: colors.white,
        },
        tabBarLabelStyle: { fontSize: 11 },
        sceneStyle: { backgroundColor: colors.background },
      }}
    >
      <Tabs.Screen
        name="Home"
        component={HomeTab}
        options={{ tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 17 }}>⌂</Text> }}
      />
      <Tabs.Screen
        name="Khata"
        component={KhataTabScreen}
        options={{ tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 17 }}>≡</Text> }}
      />
      <Tabs.Screen
        name="Transactions"
        component={TransactionsTabScreen}
        options={{ tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 17 }}>↔</Text> }}
      />
      <Tabs.Screen
        name="Chat"
        component={ChatPlaceholder}
        options={{ tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 17 }}>…</Text> }}
      />
      <Tabs.Screen
        name="Settings"
        component={SettingsTab}
        options={{ tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 17 }}>⚙</Text> }}
      />
    </Tabs.Navigator>
  );
}

function WorkspaceNavigation({
  client,
  inviteToken,
  clearInvite,
}: {
  client: OwnerBookClient;
  inviteToken?: string;
  clearInvite: () => void;
}) {
  const workspace = useWorkspace();
  const flash = useFlash();
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const business = workspace.active?.business;
  const showPicker = !!business && pickerFor === business.id;
  const owner = workspace.active?.membership.role === 'owner';
  useEffect(() => {
    // Wait until the workspace stack is actually registered. NavigationContainer
    // can become ready while the workspace is still showing its loading screen.
    if (inviteToken && !workspace.loading && navigationRef.isReady())
      navigationRef.navigate('JoinBusiness', { token: inviteToken });
  }, [inviteToken, workspace.loading]);
  const joinBusiness = (token?: string) => {
    navigationRef.navigate('JoinBusiness', { token: token ?? inviteToken });
    clearInvite();
  };
  /** Saves report what the server stored, then return to the record it changed. */
  const done = (message: string) => {
    flash.notify(message);
    if (navigationRef.canGoBack()) navigationRef.goBack();
  };
  if (workspace.loading && !workspace.profile)
    return <Loading label="Loading your businesses and profile…" />;
  return (
    <WorkspaceActionsContext.Provider
      value={{ openBusinessPicker: () => setPickerFor(business?.id ?? null), joinBusiness }}
    >
      <Stack.Navigator
        screenOptions={{
          headerTintColor: colors.green,
          headerBackTitle: 'Back',
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        {!workspace.active || showPicker ? (
          <Stack.Screen name="Businesses" options={{ headerShown: false }}>
            {() => (
              <BusinessPicker
                onOpen={() => setPickerFor(null)}
                onCreate={() => navigationRef.navigate('CreateBusiness')}
                onJoin={() => joinBusiness()}
              />
            )}
          </Stack.Screen>
        ) : (
          <Stack.Screen name="Tabs" options={{ headerShown: false }}>
            {() => <MainTabs />}
          </Stack.Screen>
        )}
        <Stack.Screen name="CreateBusiness" options={{ title: 'New business' }}>
          {() => (
            <BusinessForm
              client={client}
              onDone={() => {
                setPickerFor(null);
                if (navigationRef.canGoBack()) navigationRef.goBack();
              }}
            />
          )}
        </Stack.Screen>
        {owner && business && (
          <Stack.Screen name="BusinessSettings" options={{ title: 'Business settings' }}>
            {() => (
              <BusinessForm
                key={business.id}
                client={client}
                settings
                onDone={() => navigationRef.goBack()}
              />
            )}
          </Stack.Screen>
        )}
        {workspace.active && (
          <Stack.Screen name="Members" options={{ title: 'Team' }}>
            {() => (
              <MemberScreen
                key={business?.id}
                client={client}
                invitations={() => navigationRef.navigate('Invitations')}
                onCreate={() => navigationRef.navigate('CreateInvitation')}
              />
            )}
          </Stack.Screen>
        )}
        {workspace.canInvite && (
          <Stack.Screen name="CreateInvitation" options={{ title: 'Invite member' }}>
            {() => <CreateInvitationScreen key={business?.id} client={client} />}
          </Stack.Screen>
        )}
        {workspace.canInvite && (
          <Stack.Screen name="Invitations" options={{ title: 'Invitations' }}>
            {() => <InvitationsScreen key={business?.id} client={client} />}
          </Stack.Screen>
        )}
        <Stack.Screen name="JoinBusiness" options={{ title: 'Join business' }}>
          {({ route }) => (
            <InvitationScreen
              key={route.params?.token ?? 'manual'}
              client={client}
              initialToken={route.params?.token ?? inviteToken}
              onJoined={clearInvite}
            />
          )}
        </Stack.Screen>
        {workspace.active && (
          <Stack.Screen name="CustomerDetail" options={{ title: 'Khata' }}>
            {({ route }) => (
              <CustomerDetailScreen
                key={`${business?.id}:${route.params.customerId}`}
                client={client}
                customerId={route.params.customerId}
                onEdit={() =>
                  navigationRef.navigate('CustomerForm', { customerId: route.params.customerId })
                }
                onPayment={() =>
                  navigationRef.navigate('PaymentForm', { customerId: route.params.customerId })
                }
                onAdjust={() =>
                  navigationRef.navigate('AdjustmentForm', { customerId: route.params.customerId })
                }
              />
            )}
          </Stack.Screen>
        )}
        {workspace.active && (
          <Stack.Screen name="CustomerForm" options={{ title: 'Customer' }}>
            {({ route }) => (
              <CustomerFormScreen
                key={`${business?.id}:${route.params.customerId ?? 'new'}`}
                client={client}
                customerId={route.params.customerId ?? null}
                onDone={() => done('Customer saved.')}
              />
            )}
          </Stack.Screen>
        )}
        {workspace.active && (
          <Stack.Screen name="PaymentForm" options={{ title: 'Payment' }}>
            {({ route }) => (
              <PaymentFormScreen
                key={`${business?.id}:${route.params.customerId}`}
                client={client}
                customerId={route.params.customerId}
                onDone={done}
              />
            )}
          </Stack.Screen>
        )}
        {workspace.active && (
          <Stack.Screen name="AdjustmentForm" options={{ title: 'Khata note' }}>
            {({ route }) => (
              <AdjustmentFormScreen
                key={`${business?.id}:${route.params.customerId}`}
                client={client}
                customerId={route.params.customerId}
                onDone={done}
              />
            )}
          </Stack.Screen>
        )}
        {workspace.active && (
          <Stack.Screen name="SaleForm" options={{ title: 'New sale' }}>
            {({ route }) => (
              <SaleFormScreen
                key={`${business?.id}:${route.params.customerId ?? 'counter'}`}
                client={client}
                customerId={route.params.customerId ?? null}
                onDone={done}
              />
            )}
          </Stack.Screen>
        )}
        {workspace.active && (
          <Stack.Screen name="SaleDetail" options={{ title: 'Sale' }}>
            {({ route }) => (
              <SaleDetailScreen
                key={`${business?.id}:${route.params.saleId}`}
                client={client}
                saleId={route.params.saleId}
                onDone={done}
              />
            )}
          </Stack.Screen>
        )}
        {workspace.active && (
          <Stack.Screen name="ExpenseForm" options={{ title: 'New expense' }}>
            {() => <ExpenseFormScreen key={business?.id} client={client} onDone={done} />}
          </Stack.Screen>
        )}
        {workspace.active && (
          <Stack.Screen name="Catalog" options={{ title: 'Items' }}>
            {() => (
              <CatalogScreen
                key={business?.id}
                client={client}
                onNewProduct={() => navigationRef.navigate('ProductForm', {})}
                onEditProduct={(productId) => navigationRef.navigate('ProductForm', { productId })}
              />
            )}
          </Stack.Screen>
        )}
        {workspace.active && (
          <Stack.Screen name="ProductForm" options={{ title: 'Item' }}>
            {({ route }) => (
              <ProductFormScreen
                key={`${business?.id}:${route.params.productId ?? 'new'}`}
                client={client}
                productId={route.params.productId ?? null}
                onDone={done}
              />
            )}
          </Stack.Screen>
        )}
      </Stack.Navigator>
    </WorkspaceActionsContext.Provider>
  );
}

export function AppNavigation({
  client,
  inviteToken,
  clearInvite,
}: {
  client: OwnerBookClient;
  inviteToken?: string;
  clearInvite: () => void;
}) {
  const auth = useAuth();
  return (
    <ClientContext.Provider value={client}>
      <NavigationContainer ref={navigationRef}>
        {!auth.session || auth.recovery ? (
          <AuthScreen client={client} />
        ) : (
          <WorkspaceProvider
            key={auth.session.user.id}
            client={client}
            userId={auth.session.user.id}
          >
            <FlashProvider>
              <WorkspaceNavigation
                client={client}
                inviteToken={inviteToken}
                clearInvite={clearInvite}
              />
            </FlashProvider>
          </WorkspaceProvider>
        )}
      </NavigationContainer>
    </ClientContext.Provider>
  );
}
