import { vi } from 'vitest';
import axios, { AxiosError } from 'axios';
import { 
  mapAxiosError, 
  ApiClient, 
  useErrorHandler, 
  formatErrorMessage,
  withRetry,
  validateRequired,
  validateEmail,
  validateUrl 
} from '../errorHandler';
import { 
  AppError, 
  ValidationError, 
  NotFoundError, 
  ConflictError,
  TimeoutError,
  NetworkError 
} from '../../shared/types';
import { API_CONFIG } from '../../shared/constants';
import { 
  createMockApiResponse, 
  createMockApiError,
  mockConsole 
} from '../../shared/test-utils';

// Mock axios
vi.mock('axios');
const mockedAxios = axios as vi.Mocked<typeof axios>;

// Mock the logger
vi.mock('../logger', () => ({
  logger: {
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    getRequestId: vi.fn(() => null),
    setRequestId: vi.fn(),
  },
}));

describe('Frontend Error Handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('mapAxiosError', () => {
    it('should map successful response to AppError', () => {
      const errorResponse = createMockApiError(400, 'Bad Request');
      const axiosError = {
        response: { ...errorResponse.response, config: { headers: {} as any } },
        message: 'Request failed',
        name: 'AxiosError',
        config: { headers: {} as any },
        isAxiosError: true,
        toJSON: vi.fn(),
      } as AxiosError;

      const result = mapAxiosError(axiosError);

      expect(result).toBeInstanceOf(AppError);
      expect(result.message).toBe('Bad Request');
      expect(result.statusCode).toBe(400);
      expect(result.code).toBeUndefined();
    });

    it('should map timeout error to TimeoutError', () => {
      const axiosError = {
        code: 'ECONNABORTED',
        message: 'timeout of 10000ms exceeded',
        name: 'AxiosError',
        config: { headers: {} as any },
        isAxiosError: true,
        toJSON: vi.fn(),
      } as AxiosError;

      const result = mapAxiosError(axiosError);

      expect(result).toBeInstanceOf(TimeoutError);
      expect(result.message).toBe('Request timeout');
      expect(result.statusCode).toBe(408);
    });

    it('should map network error to NetworkError', () => {
      const axiosError = {
        code: 'NETWORK_ERROR',
        message: 'Network Error',
        name: 'AxiosError',
        config: { headers: {} as any },
        isAxiosError: true,
        toJSON: vi.fn(),
      } as AxiosError;

      const result = mapAxiosError(axiosError);

      expect(result).toBeInstanceOf(NetworkError);
      expect(result.message).toBe('Network error');
      expect(result.statusCode).toBe(0);
    });

    it('should map an error without a response to NetworkError', () => {
      const axiosError = {
        message: 'Unknown error',
        name: 'AxiosError',
        config: { headers: {} as any },
        isAxiosError: true,
        toJSON: vi.fn(),
      } as AxiosError;

      const result = mapAxiosError(axiosError);

      expect(result).toBeInstanceOf(AppError);
      expect(result.message).toBe('Network error');
      expect(result.statusCode).toBe(0);
    });
  });

  describe('ApiClient', () => {
    let apiClient: ApiClient;
    let mockAxiosInstance: any;

    beforeEach(() => {
      mockAxiosInstance = {
        defaults: { baseURL: '' },
        interceptors: {
          request: { use: vi.fn() },
          response: { use: vi.fn() },
        },
        get: vi.fn(),
        post: vi.fn(),
        patch: vi.fn(),
        delete: vi.fn(),
      };

      mockedAxios.create.mockReturnValue(mockAxiosInstance);
      apiClient = new ApiClient('http://localhost:3001');
    });

    it('should create axios instance with correct configuration', () => {
      expect(mockedAxios.create).toHaveBeenCalledWith({
        timeout: API_CONFIG.TIMEOUT_MS,
        withCredentials: true,
        headers: {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
        }
      });
    });

    it('should set baseURL correctly', () => {
      expect(mockAxiosInstance.defaults.baseURL).toBe('http://localhost:3001');
    });

    it('should setup request and response interceptors', () => {
      expect(mockAxiosInstance.interceptors.request.use).toHaveBeenCalled();
      expect(mockAxiosInstance.interceptors.response.use).toHaveBeenCalled();
    });

    describe('GET requests', () => {
      it('should make successful GET request', async () => {
        const mockData = { id: 1, name: 'Test' };
        mockAxiosInstance.get.mockResolvedValue({ data: mockData });

        const result = await apiClient.get('/test');

        expect(mockAxiosInstance.get).toHaveBeenCalledWith('/test', undefined);
        expect(result).toEqual(mockData);
      });

      it('should handle GET request errors', async () => {
        const axiosError = {
          response: { ...createMockApiError(404, 'Not Found').response, config: { headers: {} as any } },
          message: 'Not Found',
          name: 'AxiosError',
          config: { headers: {} as any },
          isAxiosError: true,
          toJSON: vi.fn(),
        } as AxiosError;

        mockAxiosInstance.get.mockRejectedValue(axiosError);

        await expect(apiClient.get('/test')).rejects.toThrow(AppError);
      });
    });

    describe('POST requests', () => {
      it('should make successful POST request', async () => {
        const mockData = { id: 1, name: 'Test' };
        const requestData = { name: 'Test' };
        mockAxiosInstance.post.mockResolvedValue({ data: mockData });

        const result = await apiClient.post('/test', requestData);

        expect(mockAxiosInstance.post).toHaveBeenCalledWith('/test', requestData, undefined);
        expect(result).toEqual(mockData);
      });

      it('should handle POST request errors', async () => {
        const axiosError = {
          response: { ...createMockApiError(400, 'Bad Request').response, config: { headers: {} as any } },
          message: 'Bad Request',
          name: 'AxiosError',
          config: { headers: {} as any },
          isAxiosError: true,
          toJSON: vi.fn(),
        } as AxiosError;

        mockAxiosInstance.post.mockRejectedValue(axiosError);

        await expect(apiClient.post('/test', {})).rejects.toThrow(AppError);
      });
    });

    describe('PATCH requests', () => {
      it('should make successful PATCH request', async () => {
        const mockData = { id: 1, name: 'Updated' };
        const requestData = { name: 'Updated' };
        mockAxiosInstance.patch.mockResolvedValue({ data: mockData });

        const result = await apiClient.patch('/test/1', requestData);

        expect(mockAxiosInstance.patch).toHaveBeenCalledWith('/test/1', requestData, undefined);
        expect(result).toEqual(mockData);
      });
    });

    describe('DELETE requests', () => {
      it('should make successful DELETE request', async () => {
        mockAxiosInstance.delete.mockResolvedValue({ data: {} });

        const result = await apiClient.delete('/test/1');

        expect(mockAxiosInstance.delete).toHaveBeenCalledWith('/test/1', undefined);
        expect(result).toEqual({});
      });
    });
  });

  describe('useErrorHandler hook', () => {
    it('should provide handleError function', () => {
      const { handleError } = useErrorHandler();
      expect(typeof handleError).toBe('function');
    });

    it('should provide handleApiError function', () => {
      const { handleApiError } = useErrorHandler();
      expect(typeof handleApiError).toBe('function');
    });

    it('should handle generic errors', () => {
      const { handleError } = useErrorHandler();
      const error = new Error('Test error');
      
      expect(() => handleError(error, 'test context')).not.toThrow();
    });

    it('should handle API errors', () => {
      const { handleApiError } = useErrorHandler();
      const error = new AppError('API error', 400, 'VALIDATION_ERROR');
      
      expect(() => handleApiError(error, 'test context')).not.toThrow();
    });
  });

  describe('formatErrorMessage', () => {
    it('should format error message without details', () => {
      const error = new AppError('Simple error');
      const result = formatErrorMessage(error);
      
      expect(result).toBe('Simple error');
    });

    it('should format error message with details', () => {
      const error = new AppError('Validation failed', 400, 'VALIDATION_ERROR', ['field1 is required', 'field2 is invalid']);
      const result = formatErrorMessage(error);
      
      expect(result).toBe('Validation failed: field1 is required, field2 is invalid');
    });
  });

  describe('withRetry', () => {
    it('should succeed on first attempt', async () => {
      const mockOperation = vi.fn().mockResolvedValue('success');
      
      const result = await withRetry(mockOperation);
      
      expect(result).toBe('success');
      expect(mockOperation).toHaveBeenCalledTimes(1);
    });

    it('should retry on failure and eventually succeed', async () => {
      const mockOperation = vi.fn()
        .mockRejectedValueOnce(new Error('First attempt failed'))
        .mockRejectedValueOnce(new Error('Second attempt failed'))
        .mockResolvedValue('success');
      
      const result = await withRetry(mockOperation, 3, 10);
      
      expect(result).toBe('success');
      expect(mockOperation).toHaveBeenCalledTimes(3);
    });

    it('should not retry on client errors', async () => {
      const mockOperation = vi.fn().mockRejectedValue(new AppError('Bad Request', 400));
      
      await expect(withRetry(mockOperation)).rejects.toThrow(AppError);
      expect(mockOperation).toHaveBeenCalledTimes(1);
    });

    it('should fail after max retries', async () => {
      const mockOperation = vi.fn().mockRejectedValue(new Error('Always fails'));
      
      await expect(withRetry(mockOperation, 2, 10)).rejects.toThrow('Always fails');
      expect(mockOperation).toHaveBeenCalledTimes(2);
    });
  });

  describe('Validation helpers', () => {
    describe('validateRequired', () => {
      it('should not throw for valid values', () => {
        expect(() => validateRequired('value', 'field')).not.toThrow();
        expect(() => validateRequired(0, 'field')).not.toThrow();
        expect(() => validateRequired(false, 'field')).not.toThrow();
      });

      it('should throw ValidationError for undefined', () => {
        expect(() => validateRequired(undefined, 'field')).toThrow(ValidationError);
      });

      it('should throw ValidationError for null', () => {
        expect(() => validateRequired(null, 'field')).toThrow(ValidationError);
      });

      it('should throw ValidationError for empty string', () => {
        expect(() => validateRequired('', 'field')).toThrow(ValidationError);
      });
    });

    describe('validateEmail', () => {
      it('should not throw for valid emails', () => {
        expect(() => validateEmail('test@example.com')).not.toThrow();
        expect(() => validateEmail('user.name+tag@domain.co.uk')).not.toThrow();
      });

      it('should throw ValidationError for invalid emails', () => {
        expect(() => validateEmail('invalid-email')).toThrow(ValidationError);
        expect(() => validateEmail('test@')).toThrow(ValidationError);
        expect(() => validateEmail('@example.com')).toThrow(ValidationError);
        expect(() => validateEmail('test.example.com')).toThrow(ValidationError);
      });
    });

    describe('validateUrl', () => {
      it('should not throw for valid URLs', () => {
        expect(() => validateUrl('https://example.com')).not.toThrow();
        expect(() => validateUrl('http://localhost:3000')).not.toThrow();
        expect(() => validateUrl('https://subdomain.example.com/path?query=value')).not.toThrow();
      });

      it('should throw ValidationError for invalid URLs', () => {
        expect(() => validateUrl('not-a-url')).toThrow(ValidationError);
        expect(() => validateUrl('ftp://example.com')).toThrow(ValidationError);
        expect(() => validateUrl('example.com')).toThrow(ValidationError);
      });
    });
  });
});
