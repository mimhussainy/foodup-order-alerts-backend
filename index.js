import { useEffect, useState } from 'react';
import {
  View, Text, TouchableOpacity,
  StyleSheet, SafeAreaView, SectionList
} from 'react-native';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface OrderAddon {
  label: string;
  value: string;
}

interface OrderItem {
  name: string;
  quantity: number;
  total: number;
  addons: OrderAddon[];
}

interface Order {
  order_id: number;
  customer_name: string;
  total: string;
  currency: string;
  status: string;
  event_type: string;
  items: OrderItem[];
  payment_method: string;
  note: string;
  date: string;
  timestamp: number;
}

function getStatusColor(status: string) {
  switch (status) {
    case 'processing': return '#2ecc71';
    case 'completed': return '#3498db';
    case 'cancelled': return '#e74c3c';
    case 'pending': return '#f39c12';
    case 'on-hold': return '#9b59b6';
    default: return '#95a5a6';
  }
}

function getStatusEmoji(status: string) {
  switch (status) {
    case 'processing': return '⚡';
    case 'completed': return '✅';
    case 'cancelled': return '❌';
    case 'pending': return '⏳';
    case 'on-hold': return '⏸️';
    default: return '📦';
  }
}

function getDateLabel(timestamp: number) {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

function groupOrdersByDate(orders: Order[]) {
  const groups: { [key: string]: Order[] } = {};
  orders.forEach(order => {
    const label = getDateLabel(order.timestamp);
    if (!groups[label]) groups[label] = [];
    groups[label].push(order);
  });
  return Object.keys(groups).map(title => ({ title, data: groups[title] }));
}

const STORAGE_KEY = 'foodup_orders';

export default function OrdersScreen() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then(stored => {
      if (stored) setOrders(JSON.parse(stored));
    });
  }, []);

  useEffect(() => {
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(orders));
  }, [orders]);

  useEffect(() => {
    const subscription = Notifications.addNotificationReceivedListener(notification => {
      const data = notification.request.content.data as any;
      const newOrder: Order = {
        order_id: parseInt(data.order_id),
        customer_name: data.customer_name,
        total: data.total,
        currency: data.currency,
        status: data.status,
        event_type: data.event_type || 'new_order',
        items: JSON.parse(data.items || '[]'),
        payment_method: data.payment_method,
        note: data.note,
        date: new Date().toLocaleString(),
        timestamp: Date.now(),
      };
      setOrders(prev => {
        const exists = prev.findIndex(o => o.order_id === newOrder.order_id);
        if (exists >= 0) {
          const updated = [...prev];
          updated[exists] = newOrder;
          return updated;
        }
        return [newOrder, ...prev];
      });
    });
    return () => subscription.remove();
  }, []);

  const sections = groupOrdersByDate(orders);

  if (selectedOrder) {
    return (
      <SafeAreaView style={styles.container}>
        <TouchableOpacity style={styles.backBtn} onPress={() => setSelectedOrder(null)}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>
        <View style={styles.detailCard}>
          <Text style={styles.detailTitle}>Order #{selectedOrder.order_id}</Text>
          <View style={[styles.statusBadge, { backgroundColor: getStatusColor(selectedOrder.status) }]}>
            <Text style={styles.statusBadgeText}>{getStatusEmoji(selectedOrder.status)} {selectedOrder.status.toUpperCase()}</Text>
          </View>
          <Text style={styles.detailText}>👤 {selectedOrder.customer_name}</Text>
          <Text style={styles.detailText}>💰 {selectedOrder.currency} {selectedOrder.total}</Text>
          <Text style={styles.detailText}>💳 {selectedOrder.payment_method}</Text>
          <Text style={styles.detailText}>🕐 {selectedOrder.date}</Text>
          {selectedOrder.note ? <Text style={styles.detailText}>📝 {selectedOrder.note}</Text> : null}
          <Text style={styles.sectionTitle}>Items:</Text>
          {selectedOrder.items.map((item, i) => (
            <View key={i} style={styles.itemBlock}>
              <Text style={styles.itemText}>
                <Text style={styles.itemBold}>{item.quantity}x {item.name}</Text>
                {' '}— {selectedOrder.currency} {item.total}
              </Text>
              {item.addons && item.addons.map((addon, j) => (
                <Text key={j} style={styles.addonText}>↳ {addon.label}: {addon.value}</Text>
              ))}
            </View>
          ))}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.header}>🛒 FoodUp Orders</Text>
      {orders.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>No orders yet.</Text>
          <Text style={styles.emptySubText}>New orders will appear here instantly!</Text>
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => String(item.order_id)}
          renderSectionHeader={({ section: { title } }) => (
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionHeaderText}>{title}</Text>
            </View>
          )}
          renderItem={({ item }) => (
            <TouchableOpacity style={styles.orderCard} onPress={() => setSelectedOrder(item)}>
              <View style={styles.orderHeader}>
                <Text style={styles.orderId}>Order #{item.order_id}</Text>
                <View style={[styles.statusPill, { backgroundColor: getStatusColor(item.status) }]}>
                  <Text style={styles.statusPillText}>{getStatusEmoji(item.status)} {item.status}</Text>
                </View>
              </View>
              <Text style={styles.orderCustomer}>{item.customer_name}</Text>
              <Text style={styles.orderTotal}>{item.currency} {item.total}</Text>
              <Text style={styles.orderDate}>{item.date}</Text>
            </TouchableOpacity>
          )}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  header: { fontSize: 24, fontWeight: 'bold', padding: 20, backgroundColor: '#fff' },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyText: { fontSize: 18, color: '#333', fontWeight: 'bold' },
  emptySubText: { fontSize: 14, color: '#999', marginTop: 8 },
  sectionHeader: { backgroundColor: '#f5f5f5', paddingHorizontal: 16, paddingVertical: 8 },
  sectionHeaderText: { fontSize: 13, fontWeight: 'bold', color: '#999', textTransform: 'uppercase' },
  orderCard: { backgroundColor: '#fff', marginHorizontal: 10, marginVertical: 5, padding: 15, borderRadius: 10, elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.1, shadowRadius: 2 },
  orderHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  orderId: { fontSize: 16, fontWeight: 'bold', color: '#333' },
  statusPill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 12 },
  statusPillText: { fontSize: 11, color: '#fff', fontWeight: 'bold' },
  orderCustomer: { fontSize: 14, color: '#666', marginTop: 6 },
  orderTotal: { fontSize: 16, fontWeight: 'bold', color: '#2ecc71', marginTop: 4 },
  orderDate: { fontSize: 11, color: '#bbb', marginTop: 4 },
  backBtn: { padding: 16 },
  backText: { fontSize: 16, color: '#007AFF' },
  detailCard: { backgroundColor: '#fff', margin: 16, padding: 20, borderRadius: 12, elevation: 2 },
  detailTitle: { fontSize: 22, fontWeight: 'bold', marginBottom: 12 },
  statusBadge: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, alignSelf: 'flex-start', marginBottom: 12 },
  statusBadgeText: { color: '#fff', fontWeight: 'bold', fontSize: 14 },
  detailText: { fontSize: 16, color: '#333', marginBottom: 8 },
  sectionTitle: { fontSize: 18, fontWeight: 'bold', marginTop: 16, marginBottom: 8 },
  itemBlock: { marginBottom: 10 },
  itemText: { fontSize: 14, color: '#555' },
  itemBold: { fontWeight: 'bold', color: '#333' },
  addonText: { fontSize: 13, color: '#888', marginLeft: 12, marginTop: 2 },
});
