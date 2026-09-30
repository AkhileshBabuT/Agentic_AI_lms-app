import type { Metric } from 'web-vitals';

const SAMPLE_RATE = 0.1;
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000/api';

export async function reportWebVitals() {
  const { onCLS, onFCP, onINP, onLCP, onTTFB } = await import('web-vitals');

  const sampled = Math.random() < SAMPLE_RATE;
  const report = (metric: Metric) => {
    const payload = { name: metric.name, value: metric.value, rating: metric.rating, id: metric.id };
    if (import.meta.env.DEV) {
      console.info('[web-vitals]', payload);
      return;
    }
    if (!sampled) return;
    const token = localStorage.getItem('token');
    if (!token) return;
    void fetch(`${API_BASE_URL}/telemetry/vitals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => undefined);
  };

  onCLS(report);
  onFCP(report);
  onINP(report);
  onLCP(report);
  onTTFB(report);
}
