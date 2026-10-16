"use client";

import { useState, useEffect } from "react";
import { Line } from "react-chartjs-2";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
} from "chart.js";
import { format, subDays } from "date-fns";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler
);

interface AnalyticsData {
  totalNotifications: number;
  delivered: number;
  acknowledged: number;
  deliveryRate: number;
  acknowledgmentRate: number;
  trendData: {
    dates: string[];
    deliveryRates: number[];
    acknowledgmentRates: number[];
  };
}
// this is the app logo
const Skeleton = ({ className = "" }: { className?: string }) => (
  <div
    className={`animate-pulse bg-slate-200 rounded ${className}`}
  ></div>
);

const MetricCardSkeleton = () => (
  <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-100">
    <Skeleton className="h-4 w-24 mb-2" />
    <Skeleton className="h-10 w-32 mb-2" />
    <Skeleton className="h-4 w-20" />
  </div>
);

const ChartSkeleton = () => (
  <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-100">
    <Skeleton className="h-6 w-48 mb-6" />
    <Skeleton className="h-64 w-full rounded-lg" />
  </div>
);

export default function AnalyticsPage() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [startDate, setStartDate] = useState(
    format(subDays(new Date(), 30), "yyyy-MM-dd")
  );
  const [endDate, setEndDate] = useState(format(new Date(), "yyyy-MM-dd"));

  const fetchAnalytics = async () => {
    setLoading(true);
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const dates: string[] = [];
    const deliveryRates: number[] = [];
    const acknowledgmentRates: number[] = [];

    for (let i = 29; i >= 0; i--) {
      const date = subDays(new Date(), i);
      dates.push(format(date, "MMM d"));
      deliveryRates.push(85 + Math.random() * 14);
      acknowledgmentRates.push(60 + Math.random() * 25);
    }

    setData({
      totalNotifications: 12847,
      delivered: 12243,
      acknowledged: 8721,
      deliveryRate: 95.3,
      acknowledgmentRate: 71.3,
      trendData: {
        dates,
        deliveryRates,
        acknowledgmentRates,
      },
    });

    setLoading(false);
  };

  useEffect(() => {
    fetchAnalytics();
  }, [startDate, endDate]);

  const chartData = {
    labels: data?.trendData.dates || [],
    datasets: [
      {
        label: "Delivery Rate",
        data: data?.trendData.deliveryRates || [],
        borderColor: "#4f46e5",
        backgroundColor: "rgba(79, 70, 229, 0.1)",
        fill: true,
        tension: 0.4,
        pointRadius: 3,
      },
      {
        label: "Acknowledgment Rate",
        data: data?.trendData.acknowledgmentRates || [],
        borderColor: "#10b981",
        backgroundColor: "rgba(16, 185, 129, 0.1)",
        fill: true,
        tension: 0.4,
        pointRadius: 3,
      },
    ],
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: true,
    plugins: {
      legend: {
        position: "top" as const,
        labels: {
          padding: 20,
          usePointStyle: true,
        },
      },
    },
    scales: {
      y: {
        beginAtZero: true,
        max: 100,
        ticks: {
          callback: (value: any) => `${value}%`,
        },
      },
    },
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-col md:flex-row md:items-center justify-between mb-8 gap-4">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold text-slate-800 mb-2">
              Analytics Dashboard
            </h1>
            <p className="text-slate-500">
              Actionable insights into your notification performance
            </p>
          </div>

          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-slate-500">Start Date</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="px-4 py-2 border border-slate-200 rounded-lg bg-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-slate-500">End Date</label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="px-4 py-2 border border-slate-200 rounded-lg bg-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {loading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <MetricCardSkeleton key={i} />
            ))
          ) : (
            <>
              <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-100">
                <p className="text-slate-500 text-sm font-medium mb-2">
                  Total Notifications
                </p>
                <p className="text-3xl font-bold text-slate-800 mb-1">
                  {data?.totalNotifications.toLocaleString()}
                </p>
                <p className="text-green-600 text-sm">+12.5% from last period</p>
              </div>

              <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-100">
                <p className="text-slate-500 text-sm font-medium mb-2">
                  Delivered
                </p>
                <p className="text-3xl font-bold text-slate-800 mb-1">
                  {data?.delivered.toLocaleString()}
                </p>
                <div className="flex items-center gap-2">
                  <p className="text-indigo-600 text-sm font-semibold">
                    {data?.deliveryRate}%
                  </p>
                  <p className="text-slate-400 text-sm">delivery rate</p>
                </div>
              </div>

              <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-100">
                <p className="text-slate-500 text-sm font-medium mb-2">
                  Acknowledged
                </p>
                <p className="text-3xl font-bold text-slate-800 mb-1">
                  {data?.acknowledged.toLocaleString()}
                </p>
                <div className="flex items-center gap-2">
                  <p className="text-emerald-600 text-sm font-semibold">
                    {data?.acknowledgmentRate}%
                  </p>
                  <p className="text-slate-400 text-sm">acknowledgment rate</p>
                </div>
              </div>

              <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-100">
                <p className="text-slate-500 text-sm font-medium mb-2">
                  Failed Deliveries
                </p>
                <p className="text-3xl font-bold text-slate-800 mb-1">
                  {data ? (data.totalNotifications - data.delivered).toLocaleString() : 0}
                </p>
                <p className="text-red-600 text-sm">-2.3% from last period</p>
              </div>
            </>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4">
          {loading ? (
            <ChartSkeleton />
          ) : (
            <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-100">
              <h2 className="text-lg font-semibold text-slate-800 mb-6">
                Performance Trends
              </h2>
              <div className="h-64 md:h-80">
                <Line data={chartData} options={chartOptions} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
