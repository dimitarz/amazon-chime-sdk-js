/**
 * An observable that behaves like a reusable promise; tracks the last-resolved value.
 *
 * This is missing subscribe(), which "real" Observables implement.
 */
 export default class DeferredObservable<T = any> {
    /** Access the last-resolved value of next() */
    value: T | undefined = undefined;
  
    private promise?: Promise<T>;
    private resolve: (value: T) => void = () => {};
  
    /** Create a promise that resolves once next() is called */
    whenNext(): Promise<T> {
      if (!this.promise) {
        // externally-resolvable promise
        this.promise = new Promise((resolve) => (this.resolve = resolve));
      }
      return this.promise;
    }
  
    /** Update the value and resolve */
    next(value: T) {
      // store the value, for sync access
      this.value = value;
      // resolve the promise so anyone awaiting whenNext resolves
      this.resolve(value);
      // delete the promise so future whenNext calls get a new promise
      delete this.promise;
    }
  }