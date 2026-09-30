import React, { createContext, useContext, useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import axios from 'axios';
import { queryClient } from '../data/queryClient';

interface User {
  id: number;
  fullName: string;
  email: string;
  role: string;
  status?: string;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  login: (email: string, password: string) => Promise<void>;
  signup: (fullName: string, email: string, password: string, role: string) => Promise<{ requiresApproval: boolean }>;
  logout: () => void;
  loading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Configure axios defaults - Updated 2026-01-23
const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000/api';
console.log('[AuthContext] API Base URL:', API_BASE);
axios.defaults.baseURL = API_BASE;

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(localStorage.getItem('token'));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const initAuth = async () => {
      const storedToken = localStorage.getItem('token');
      const storedUser = localStorage.getItem('user');

      if (storedToken && storedUser) {
        try {
          // Set the token in axios headers
          axios.defaults.headers.common['Authorization'] = `Bearer ${storedToken}`;
          setToken(storedToken);
          setUser(JSON.parse(storedUser));
        } catch (error) {
          console.error('Token verification failed:', error);
          localStorage.removeItem('token');
          localStorage.removeItem('user');
          queryClient.clear();
          setToken(null);
          setUser(null);
        }
      }
      setLoading(false);
    };

    initAuth();
  }, []);

  const login = async (email: string, password: string) => {
    try {
      const response = await axios.post('/auth/login', { email, password });
      const { user: userData, token: userToken } = response.data;

      localStorage.setItem('token', userToken);
      queryClient.clear();
      localStorage.setItem('user', JSON.stringify(userData));
      axios.defaults.headers.common['Authorization'] = `Bearer ${userToken}`;

      setUser(userData);
      setToken(userToken);
    } catch (error: unknown) {
      const message = axios.isAxiosError(error) ? error.response?.data?.error : undefined;
      throw new Error(typeof message === 'string' ? message : 'Login failed');
    }
  };

  const signup = async (fullName: string, email: string, password: string, role: string) => {
    try {
      const response = await axios.post('/auth/signup', { fullName, email, password, role });
      const { user: userData, token: userToken, requiresApproval } = response.data;

      localStorage.setItem('token', userToken);
      queryClient.clear();
      localStorage.setItem('user', JSON.stringify(userData));
      axios.defaults.headers.common['Authorization'] = `Bearer ${userToken}`;

      setUser(userData);
      setToken(userToken);

      return { requiresApproval: requiresApproval || false };
    } catch (error: unknown) {
      const message = axios.isAxiosError(error) ? error.response?.data?.error : undefined;
      throw new Error(typeof message === 'string' ? message : 'Signup failed');
    }
  };

  const logout = () => {
    queryClient.clear();
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    delete axios.defaults.headers.common['Authorization'];
    setUser(null);
    setToken(null);
  };

  const value = {
    user,
    token,
    login,
    signup,
    logout,
    loading
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};

// The hook shares this context's public module so existing route imports stay stable.
// eslint-disable-next-line react-refresh/only-export-components
export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
