//! Application Domains

use crate::avm2::activation::Activation;
use crate::avm2::object::{ByteArrayObject, TObject};
use crate::avm2::property_map::PropertyMap;
use crate::avm2::script::Script;
use crate::avm2::value::Value;
use crate::avm2::Error;
use crate::avm2::Multiname;
use crate::avm2::QName;
use gc_arena::{Collect, GcCell, MutationContext};

use super::class::Class;
use super::string::AvmString;

/// Represents a set of scripts and movies that share traits across different
/// script-global scopes.
#[derive(Copy, Clone, Collect)]
#[collect(no_drop)]
pub struct Domain<'gc>(GcCell<'gc, DomainData<'gc>>);

#[derive(Clone, Collect)]
#[collect(no_drop)]
struct DomainData<'gc> {
    /// A list of all exported definitions and the script that exported them.
    defs: PropertyMap<'gc, Script<'gc>>,

    /// A map of all Clasess defined in this domain. Used by ClassObject
    /// to perform early interface resolution.
    classes: PropertyMap<'gc, GcCell<'gc, Class<'gc>>>,

    /// The parent domain.
    parent: Option<Domain<'gc>>,

    /// The bytearray used for storing domain memory
    ///
    /// Note: While this property is optional, it is not recommended to set it
    /// to `None`. It is only optional to avoid an order-of-events problem in
    /// player globals setup (we need a global domain to put globals into, but
    /// that domain needs the bytearray global)
    pub domain_memory: Option<ByteArrayObject<'gc>>,
}

impl<'gc> Domain<'gc> {
    /// Create a new domain with no parent.
    ///
    /// This is intended exclusively for creating the player globals domain,
    /// hence the name.
    ///
    /// Note: the global domain will be created without valid domain memory.
    /// You must initialize domain memory later on after the ByteArray class is
    /// instantiated but before user code runs.
    pub fn global_domain(mc: MutationContext<'gc, '_>) -> Domain<'gc> {
        Self(GcCell::allocate(
            mc,
            DomainData {
                defs: PropertyMap::new(),
                classes: PropertyMap::new(),
                parent: None,
                domain_memory: None,
            },
        ))
    }

    pub fn is_avm2_global_domain(&self, activation: &mut Activation<'_, 'gc>) -> bool {
        activation.avm2().global_domain().0.as_ptr() == self.0.as_ptr()
    }

    /// Create a new domain with a given parent.
    ///
    /// This function must not be called before the player globals have been
    /// fully allocated.
    pub fn movie_domain(activation: &mut Activation<'_, 'gc>, parent: Domain<'gc>) -> Domain<'gc> {
        let this = Self(GcCell::allocate(
            activation.context.gc_context,
            DomainData {
                defs: PropertyMap::new(),
                classes: PropertyMap::new(),
                parent: Some(parent),
                domain_memory: None,
            },
        ));

        this.init_default_domain_memory(activation).unwrap();

        this
    }

    /// Get the parent of this domain
    pub fn parent_domain(self) -> Option<Domain<'gc>> {
        self.0.read().parent
    }

    /// Determine if something has been defined within the current domain.
    pub fn has_definition(self, name: QName<'gc>) -> bool {
        let read = self.0.read();

        if read.defs.contains_key(name) {
            return true;
        }

        if let Some(parent) = read.parent {
            return parent.has_definition(name);
        }

        false
    }

    /// Resolve a Multiname and return the script that provided it.
    ///
    /// If a name does not exist or cannot be resolved, no script or name will
    /// be returned.
    pub fn get_defining_script(
        self,
        multiname: &Multiname<'gc>,
    ) -> Result<Option<(QName<'gc>, Script<'gc>)>, Error<'gc>> {
        let read = self.0.read();

        if let Some(name) = multiname.local_name() {
            if let Some((ns, script)) = read.defs.get_with_ns_for_multiname(multiname) {
                let qname = QName::new(ns, name);
                return Ok(Some((qname, *script)));
            }
        }

        if let Some(parent) = read.parent {
            return parent.get_defining_script(multiname);
        }

        Ok(None)
    }

    pub fn get_class(
        self,
        multiname: &Multiname<'gc>,
    ) -> Result<Option<GcCell<'gc, Class<'gc>>>, Error<'gc>> {
        let read = self.0.read();
        if let Some(class) = read.classes.get_for_multiname(multiname).copied() {
            return Ok(Some(class));
        }

        if let Some(parent) = read.parent {
            return parent.get_class(multiname);
        }

        Ok(None)
    }

    /// Resolve a Multiname and return the script that provided it.
    ///
    /// If a name does not exist or cannot be resolved, an error will be thrown.
    pub fn find_defining_script(
        self,
        activation: &mut Activation<'_, 'gc>,
        multiname: &Multiname<'gc>,
    ) -> Result<(QName<'gc>, Script<'gc>), Error<'gc>> {
        match self.get_defining_script(multiname)? {
            Some(val) => Ok(val),
            None => Err(Error::AvmError(crate::avm2::error::reference_error(
                activation,
                &format!(
                    "Error #1065: Variable {} is not defined.",
                    multiname
                        .local_name()
                        .ok_or("Attempted to resolve uninitiated multiname")?
                ),
                1065,
            )?)),
        }
    }

    /// Retrieve a value from this domain.
    pub fn get_defined_value(
        self,
        activation: &mut Activation<'_, 'gc>,
        name: QName<'gc>,
    ) -> Result<Value<'gc>, Error<'gc>> {
        let (name, mut script) = self.find_defining_script(activation, &name.into())?;
        let globals = script.globals(&mut activation.context)?;

        globals.get_property(&name.into(), activation)
    }

    /// Retrieve a value from this domain, with special handling for 'Vector.<SomeType>'.
    /// This is used by `getQualifiedClassName, ApplicationDomain.getDefinition, and ApplicationDomain.hasDefinition`.
    pub fn get_defined_value_handling_vector(
        self,
        activation: &mut Activation<'_, 'gc>,
        mut name: QName<'gc>,
    ) -> Result<Value<'gc>, Error<'gc>> {
        // Special-case lookups of `Vector.<SomeType>` - these get internally converted
        // to a lookup of `Vector,` a lookup of `SomeType`, and `vector_class.apply(some_type_class)`
        let mut type_name = None;
        if (name.namespace() == activation.avm2().vector_public_namespace
            || name.namespace() == activation.avm2().vector_internal_namespace
            || name.namespace() == activation.avm2().public_namespace)
            && (name.local_name().starts_with(b"Vector.<".as_slice())
                && name.local_name().ends_with(b">".as_slice()))
        {
            let local_name = name.local_name();
            type_name = Some(AvmString::new(
                activation.context.gc_context,
                &local_name["Vector.<".len()..(local_name.len() - 1)],
            ));
            name = QName::new(activation.avm2().vector_public_namespace, "Vector");
        }
        let res = self.get_defined_value(activation, name);

        if let Some(type_name) = type_name {
            let type_qname = QName::from_qualified_name(type_name, activation);
            let type_class = self.get_defined_value(activation, type_qname)?;
            if let Ok(res) = res {
                let class = res.as_object().ok_or_else(|| {
                    Error::RustError(format!("Vector type {:?} was not an object", res).into())
                })?;
                return class.apply(activation, &[type_class]).map(|obj| obj.into());
            }
        }
        res
    }

    /// Export a definition from a script into the current application domain.
    ///
    /// This does nothing if the definition already exists.
    pub fn export_definition(
        &mut self,
        name: QName<'gc>,
        script: Script<'gc>,
        mc: MutationContext<'gc, '_>,
    ) {
        if self.has_definition(name) {
            return;
        }

        self.0.write(mc).defs.insert(name, script);
    }

    pub fn export_class(&self, class: GcCell<'gc, Class<'gc>>, mc: MutationContext<'gc, '_>) {
        self.0.write(mc).classes.insert(class.read().name(), class);
    }

    pub fn domain_memory(&self) -> ByteArrayObject<'gc> {
        self.0
            .read()
            .domain_memory
            .expect("Domain must have valid memory at all times")
    }

    pub fn set_domain_memory(
        &self,
        mc: MutationContext<'gc, '_>,
        domain_memory: ByteArrayObject<'gc>,
    ) {
        self.0.write(mc).domain_memory = Some(domain_memory)
    }

    /// Allocate the default domain memory for this domain, if it does not
    /// already exist.
    ///
    /// This function is only necessary to be called for domains created via
    /// `global_domain`. It will do nothing on already fully-initialized
    /// domains.
    pub fn init_default_domain_memory(
        self,
        activation: &mut Activation<'_, 'gc>,
    ) -> Result<(), Error<'gc>> {
        let bytearray_class = activation.avm2().classes().bytearray;

        let domain_memory = bytearray_class.construct(activation, &[])?;
        domain_memory
            .as_bytearray_mut(activation.context.gc_context)
            .unwrap()
            .set_length(1024);

        let mut write = self.0.write(activation.context.gc_context);
        write
            .domain_memory
            .get_or_insert(domain_memory.as_bytearray_object().unwrap());

        Ok(())
    }
}

impl<'gc> PartialEq for Domain<'gc> {
    fn eq(&self, other: &Self) -> bool {
        self.0.as_ptr() == other.0.as_ptr()
    }
}

impl<'gc> Eq for Domain<'gc> {}
